import type {
  RemoteWorkspaceObservedWorktree,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTabObservation
} from '../../shared/remote-workspace-types'
import {
  findObservedIntentWorktree,
  reconcileTabIntentSnapshot,
  sessionMatchesTabObservation,
  sessionTabMatchesIntent,
  type RemoteWorkspaceTabIntent
} from './remote-workspace-tab-intent-reconciliation'
import {
  boundedRemoteWorkspaceObservedWorktrees,
  isValidRemoteWorkspaceTargetId,
  remoteWorkspaceObservedTabMap
} from './remote-workspace-tab-observation-bounds'
import type {
  RemoteWorkspacePatchIntentCapture,
  RemoteWorkspaceTabObservationAuthority
} from './remote-workspace-tab-intent-types'
import {
  MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS,
  RemoteWorkspaceUntrackedIntentFences
} from './remote-workspace-untracked-intent-fences'

type TargetState = {
  authority: RemoteWorkspaceTabObservationAuthority
  connected: boolean
  intents: Map<string, RemoteWorkspaceTabIntent>
  overflowed: boolean
  sequence: number
  worktrees: Map<string, RemoteWorkspaceObservedWorktree>
}

export const MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS = 64
export { MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS }

export class RemoteWorkspaceTabIntentStore {
  private readonly targets = new Map<string, TargetState>()
  private readonly untracked = new RemoteWorkspaceUntrackedIntentFences()

  observe(
    authority: RemoteWorkspaceTabObservationAuthority,
    observation: RemoteWorkspaceTabObservation
  ): void {
    if (
      observation.hydrated !== true ||
      observation.rendererGeneration !== authority.rendererGeneration ||
      !isValidRemoteWorkspaceTargetId(observation.targetId)
    ) {
      return
    }
    const existing = this.targets.get(observation.targetId)
    if (existing && !this.canObserve(existing.authority, authority)) {
      return
    }
    if (!this.untracked.canObserve(observation.targetId, authority)) {
      return
    }
    const nextWorktrees = boundedRemoteWorkspaceObservedWorktrees(observation)
    if (!nextWorktrees) {
      if (existing) {
        existing.overflowed = true
      } else if (this.targets.size < MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        this.targets.set(observation.targetId, {
          authority,
          connected: observation.connected === true,
          intents: new Map(),
          overflowed: true,
          sequence: 0,
          worktrees: new Map()
        })
      } else {
        this.untracked.record(observation.targetId, authority)
      }
      return
    }
    if (!existing) {
      const replacedBaseline =
        this.targets.size >= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS
          ? this.evictBaseline(observation.connected === true)
          : false
      if (this.targets.size >= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        if (observation.authoritative !== true) {
          this.untracked.record(observation.targetId, authority)
        }
        return
      }
      this.untracked.clear(observation.targetId)
      this.targets.set(observation.targetId, {
        authority,
        connected: observation.connected === true,
        intents: new Map(),
        overflowed: replacedBaseline && observation.authoritative !== true,
        sequence: 0,
        worktrees: nextWorktrees
      })
      return
    }

    if (
      observation.authoritative ||
      authority.rendererGeneration > existing.authority.rendererGeneration
    ) {
      existing.authority = authority
      existing.connected = observation.connected === true
      existing.worktrees = nextWorktrees
      this.touch(observation.targetId, existing)
      return
    }

    for (const worktreeId of new Set([...existing.worktrees.keys(), ...nextWorktrees.keys()])) {
      const previous = existing.worktrees.get(worktreeId)
      const next = nextWorktrees.get(worktreeId)
      if (!previous || !next || previous.worktreeInstanceId !== next.worktreeInstanceId) {
        if (previous || next) {
          existing.overflowed ||=
            previous?.worktreeInstanceId === null || next?.worktreeInstanceId === null
        }
        continue
      }
      if (!next.worktreeInstanceId) {
        if (previous.tabs.length !== next.tabs.length) {
          existing.overflowed = true
        }
        continue
      }
      const previousTabs = remoteWorkspaceObservedTabMap(previous)
      const nextTabs = remoteWorkspaceObservedTabMap(next)
      for (const slot of new Set([...previousTabs.keys(), ...nextTabs.keys()])) {
        const before = previousTabs.get(slot)
        const after = nextTabs.get(slot)
        if (before?.processIdentity === after?.processIdentity) {
          continue
        }
        const observed = after ?? before
        if (!observed) {
          continue
        }
        existing.sequence += 1
        existing.intents.set(slot, {
          presence: after ? 'present' : 'absent',
          processIdentity: observed.processIdentity,
          sequence: existing.sequence,
          tab: observed,
          worktree: {
            worktreeId: next.worktreeId,
            worktreeInstanceId: next.worktreeInstanceId,
            worktreePath: next.worktreePath
          }
        })
        if (existing.intents.size > MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET) {
          existing.intents.clear()
          existing.overflowed = true
          break
        }
      }
    }
    existing.connected = observation.connected === true
    existing.worktrees = nextWorktrees
    this.touch(observation.targetId, existing)
  }

  forgetTarget(targetId: string, authority: RemoteWorkspaceTabObservationAuthority): void {
    this.untracked.forget(targetId, authority)
    const state = this.targets.get(targetId)
    if (state && this.canObserve(state.authority, authority)) {
      this.targets.delete(targetId)
    }
  }

  hasPending(targetId: string): boolean {
    const state = this.targets.get(targetId)
    return Boolean(
      state?.overflowed || state?.intents.size || (!state && this.untracked.blocks(targetId))
    )
  }

  reconcile(targetId: string, snapshot: RemoteWorkspaceSnapshot): RemoteWorkspaceSnapshot | null {
    const state = this.targets.get(targetId)
    if (!state && this.untracked.blocks(targetId)) {
      return null
    }
    if (state?.overflowed) {
      return null
    }
    if (!state || state.intents.size === 0) {
      return snapshot
    }
    return reconcileTabIntentSnapshot(state.worktrees, state.intents, snapshot)
  }

  capturePatch(
    targetId: string,
    session: RemoteWorkspaceSession
  ): RemoteWorkspacePatchIntentCapture {
    const state = this.targets.get(targetId)
    if (!state) {
      return {
        fullSnapshot: false,
        sequences: new Map(),
        untracked: this.untracked.capture(targetId)
      }
    }
    return {
      fullSnapshot: state.overflowed && sessionMatchesTabObservation(state.worktrees, session),
      sequences: new Map(
        [...state.intents]
          .filter(
            ([, intent]) =>
              findObservedIntentWorktree(state.worktrees, intent) !== undefined &&
              sessionTabMatchesIntent(session, intent)
          )
          .map(([slot, intent]) => [slot, intent.sequence])
      ),
      untracked: null
    }
  }

  acknowledgePatch(
    targetId: string,
    capture: RemoteWorkspacePatchIntentCapture,
    result: RemoteWorkspacePatchResult
  ): void {
    if (!result.ok) {
      return
    }
    this.untracked.acknowledge(targetId, capture.untracked)
    const state = this.targets.get(targetId)
    if (!state) {
      return
    }
    for (const [slot, sequence] of capture.sequences) {
      const intent = state.intents.get(slot)
      if (
        intent?.sequence === sequence &&
        sessionTabMatchesIntent(result.snapshot.session, intent)
      ) {
        state.intents.delete(slot)
      }
    }
    if (
      capture.fullSnapshot &&
      sessionMatchesTabObservation(state.worktrees, result.snapshot.session)
    ) {
      state.overflowed = false
    }
  }

  stateForTests(targetId: string): { intents: number; overflowed: boolean } | null {
    const state = this.targets.get(targetId)
    return state ? { intents: state.intents.size, overflowed: state.overflowed } : null
  }

  resetForTests(): void {
    this.targets.clear()
    this.untracked.reset()
  }

  private evictBaseline(incomingConnected: boolean): boolean {
    const candidates = [...this.targets].filter(
      ([, state]) => !state.overflowed && state.intents.size === 0
    )
    const victim =
      candidates.find(([, state]) => !state.connected) ??
      (incomingConnected ? candidates[0] : undefined)
    if (!victim) {
      return false
    }
    this.targets.delete(victim[0])
    return true
  }

  private touch(targetId: string, state: TargetState): void {
    this.targets.delete(targetId)
    this.targets.set(targetId, state)
  }

  private canObserve(
    current: RemoteWorkspaceTabObservationAuthority,
    candidate: RemoteWorkspaceTabObservationAuthority
  ): boolean {
    return (
      candidate.rendererGeneration > current.rendererGeneration ||
      this.sameAuthority(current, candidate)
    )
  }

  private sameAuthority(
    left: RemoteWorkspaceTabObservationAuthority,
    right: RemoteWorkspaceTabObservationAuthority
  ): boolean {
    return (
      left.rendererGeneration === right.rendererGeneration &&
      left.processId === right.processId &&
      left.senderId === right.senderId
    )
  }
}
