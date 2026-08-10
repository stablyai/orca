import type {
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
import {
  MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET,
  MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET,
  MAX_REMOTE_WORKSPACE_TAB_RETAINED_BYTES,
  RemoteWorkspaceTabIntentRetention,
  type RemoteWorkspaceTabIntentTargetState as TargetState
} from './remote-workspace-tab-intent-retention'
import type {
  RemoteWorkspacePatchIntentCapture,
  RemoteWorkspaceTabObservationAuthority
} from './remote-workspace-tab-intent-types'
import {
  MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS,
  RemoteWorkspaceUntrackedIntentFences
} from './remote-workspace-untracked-intent-fences'
import {
  canReplaceRemoteWorkspaceTabObservationAuthority,
  sameRemoteWorkspaceTabObservationAuthority
} from './remote-workspace-tab-observation-owner'

export const MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS = 64
export {
  MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET,
  MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET,
  MAX_REMOTE_WORKSPACE_TAB_RETAINED_BYTES,
  MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS
}

export class RemoteWorkspaceTabIntentStore {
  private readonly retention = new RemoteWorkspaceTabIntentRetention()
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
    if (
      existing &&
      !canReplaceRemoteWorkspaceTabObservationAuthority(existing.authority, authority)
    ) {
      return
    }
    if (!this.untracked.canObserve(observation.targetId, authority)) {
      return
    }
    const boundedObservation = boundedRemoteWorkspaceObservedWorktrees(observation)
    if (!boundedObservation) {
      if (existing) {
        this.retention.overflow(existing)
      } else if (this.targets.size < MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        const state = this.retention.createTarget(
          authority,
          observation.connected === true,
          new Map(),
          0
        )
        state.overflowed = true
        this.targets.set(observation.targetId, state)
      } else {
        this.untracked.record(observation.targetId, authority)
      }
      return
    }
    const { retainedBytes: nextWorktreeBytes, worktrees: nextWorktrees } = boundedObservation
    if (!existing) {
      const replacedBaseline =
        this.targets.size >= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS
          ? this.retention.evictBaseline(this.targets, observation.connected === true)
          : false
      if (this.targets.size >= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        if (observation.authoritative !== true) {
          this.untracked.record(observation.targetId, authority)
        }
        return
      }
      this.untracked.clear(observation.targetId)
      const state = this.retention.createTarget(
        authority,
        observation.connected === true,
        nextWorktrees,
        nextWorktreeBytes
      )
      state.overflowed ||= replacedBaseline && observation.authoritative !== true
      this.targets.set(observation.targetId, state)
      return
    }

    if (
      observation.authoritative ||
      authority.rendererGeneration > existing.authority.rendererGeneration
    ) {
      existing.authority = authority
      existing.connected = observation.connected === true
      this.retention.replaceWorktrees(existing, nextWorktrees, nextWorktreeBytes)
      this.touch(observation.targetId, existing)
      return
    }

    if (existing.overflowed) {
      existing.connected = observation.connected === true
      this.retention.replaceWorktrees(existing, nextWorktrees, nextWorktreeBytes)
      this.touch(observation.targetId, existing)
      return
    }
    observationScan: for (const worktreeId of new Set([
      ...existing.worktrees.keys(),
      ...nextWorktrees.keys()
    ])) {
      const previous = existing.worktrees.get(worktreeId)
      const next = nextWorktrees.get(worktreeId)
      if (!previous || !next || previous.worktreeInstanceId !== next.worktreeInstanceId) {
        if (
          (previous || next) &&
          (previous?.worktreeInstanceId === null || next?.worktreeInstanceId === null)
        ) {
          this.retention.overflow(existing)
          break observationScan
        }
        continue
      }
      if (!next.worktreeInstanceId) {
        if (previous.tabs.length !== next.tabs.length) {
          this.retention.overflow(existing)
          break observationScan
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
        const intent: RemoteWorkspaceTabIntent = {
          presence: after ? 'present' : 'absent',
          processIdentity: observed.processIdentity,
          sequence: existing.sequence + 1,
          tab: observed,
          worktree: {
            worktreeId: next.worktreeId,
            worktreeInstanceId: next.worktreeInstanceId,
            worktreePath: next.worktreePath
          }
        }
        if (!this.retention.retain(existing, slot, intent)) {
          break observationScan
        }
      }
    }
    existing.connected = observation.connected === true
    this.retention.replaceWorktrees(existing, nextWorktrees, nextWorktreeBytes)
    this.touch(observation.targetId, existing)
  }

  forgetTarget(targetId: string, authority: RemoteWorkspaceTabObservationAuthority): void {
    this.untracked.forget(targetId, authority)
    const state = this.targets.get(targetId)
    if (state && canReplaceRemoteWorkspaceTabObservationAuthority(state.authority, authority)) {
      this.retention.release(state)
      this.targets.delete(targetId)
    }
  }

  forgetAll(authority: RemoteWorkspaceTabObservationAuthority): void {
    this.untracked.forgetAll(authority)
    for (const [targetId, state] of this.targets) {
      if (canReplaceRemoteWorkspaceTabObservationAuthority(state.authority, authority)) {
        this.retention.release(state)
        this.targets.delete(targetId)
      }
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
        tracked: null,
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
      tracked: { authority: state.authority, lifecycle: state.lifecycle },
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
    if (
      !state ||
      !capture.tracked ||
      capture.tracked.lifecycle !== state.lifecycle ||
      !sameRemoteWorkspaceTabObservationAuthority(capture.tracked.authority, state.authority)
    ) {
      return
    }
    for (const [slot, sequence] of capture.sequences) {
      const intent = state.intents.get(slot)
      if (
        intent?.sequence === sequence &&
        sessionTabMatchesIntent(result.snapshot.session, intent)
      ) {
        this.retention.acknowledge(state, slot, intent)
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
    this.retention.reset()
    this.targets.clear()
    this.untracked.reset()
  }

  private touch(targetId: string, state: TargetState): void {
    this.targets.delete(targetId)
    this.targets.set(targetId, state)
  }
}
