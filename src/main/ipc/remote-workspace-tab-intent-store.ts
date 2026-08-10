import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceObservedWorktree,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTabObservation,
  RemoteWorkspaceTerminalTab
} from '../../shared/remote-workspace-types'
import {
  findObservedIntentWorktree,
  reconcileTabIntentSnapshot,
  sessionMatchesTabObservation,
  sessionTabMatchesIntent,
  type RemoteWorkspaceTabIntent
} from './remote-workspace-tab-intent-reconciliation'

type TargetState = {
  intents: Map<string, RemoteWorkspaceTabIntent>
  overflowed: boolean
  rendererInstanceId: string
  sequence: number
  worktrees: Map<string, RemoteWorkspaceObservedWorktree>
}

export type RemoteWorkspacePatchIntentCapture = {
  fullSnapshot: boolean
  sequences: Map<string, number>
}

export const MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS = 64
export const MAX_REMOTE_WORKSPACE_OBSERVED_WORKTREES_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_OBSERVED_TABS_PER_TARGET = 4_096

function tabSlotKey(worktreeInstanceId: string, tab: RemoteWorkspaceTerminalTab): string {
  return JSON.stringify([worktreeInstanceId, tab.id, tab.createdAt])
}

function observedTabMap(
  worktree: RemoteWorkspaceObservedWorktree
): Map<string, RemoteWorkspaceObservedTab> {
  if (!worktree.worktreeInstanceId) {
    return new Map()
  }
  return new Map(
    worktree.tabs.map((tab) => [tabSlotKey(worktree.worktreeInstanceId!, tab.tab), tab])
  )
}

function boundedObservedWorktrees(
  observation: RemoteWorkspaceTabObservation
): Map<string, RemoteWorkspaceObservedWorktree> | null {
  if (
    !observation.targetId ||
    observation.targetId.length > 512 ||
    !observation.rendererInstanceId ||
    observation.rendererInstanceId.length > 256 ||
    !Array.isArray(observation.worktrees) ||
    observation.worktrees.length > MAX_REMOTE_WORKSPACE_OBSERVED_WORKTREES_PER_TARGET
  ) {
    return null
  }
  const worktrees = new Map<string, RemoteWorkspaceObservedWorktree>()
  let tabCount = 0
  for (const worktree of observation.worktrees) {
    if (!Array.isArray(worktree.tabs)) {
      return null
    }
    tabCount += worktree.tabs.length
    if (
      tabCount > MAX_REMOTE_WORKSPACE_OBSERVED_TABS_PER_TARGET ||
      !worktree.worktreeId ||
      worktree.worktreeId.length > 4_096 ||
      !worktree.worktreePath ||
      worktree.worktreePath.length > 4_096 ||
      worktree.worktreeInstanceId?.length === 0 ||
      (worktree.worktreeInstanceId?.length ?? 0) > 256 ||
      worktrees.has(worktree.worktreeId) ||
      worktree.tabs.some(
        (entry) =>
          !entry.tab.id || entry.tab.id.length > 512 || entry.processIdentity.length > 4_096
      )
    ) {
      return null
    }
    worktrees.set(worktree.worktreeId, worktree)
  }
  return worktrees
}

export class RemoteWorkspaceTabIntentStore {
  private readonly targets = new Map<string, TargetState>()
  private targetCapacityExceeded = false

  observe(observation: RemoteWorkspaceTabObservation): void {
    const existing = this.targets.get(observation.targetId)
    const nextWorktrees = boundedObservedWorktrees(observation)
    if (!nextWorktrees) {
      if (existing) {
        existing.overflowed = true
      } else if (this.targets.size < MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        this.targets.set(observation.targetId, {
          intents: new Map(),
          overflowed: true,
          rendererInstanceId: observation.rendererInstanceId,
          sequence: 0,
          worktrees: new Map()
        })
      } else {
        this.targetCapacityExceeded = true
      }
      return
    }
    if (!existing) {
      if (this.targets.size >= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS) {
        this.targetCapacityExceeded = true
        return
      }
      this.targets.set(observation.targetId, {
        intents: new Map(),
        overflowed: false,
        rendererInstanceId: observation.rendererInstanceId,
        sequence: 0,
        worktrees: nextWorktrees
      })
      return
    }

    if (
      observation.authoritative ||
      existing.rendererInstanceId !== observation.rendererInstanceId
    ) {
      existing.rendererInstanceId = observation.rendererInstanceId
      existing.worktrees = nextWorktrees
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
      const previousTabs = observedTabMap(previous)
      const nextTabs = observedTabMap(next)
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
    existing.worktrees = nextWorktrees
  }

  forgetTarget(targetId: string): void {
    this.targets.delete(targetId)
  }

  hasPending(targetId: string): boolean {
    const state = this.targets.get(targetId)
    return this.targetCapacityExceeded || Boolean(state?.overflowed || state?.intents.size)
  }

  reconcile(targetId: string, snapshot: RemoteWorkspaceSnapshot): RemoteWorkspaceSnapshot | null {
    const state = this.targets.get(targetId)
    if (this.targetCapacityExceeded || state?.overflowed) {
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
      return { fullSnapshot: false, sequences: new Map() }
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
      )
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
    this.targetCapacityExceeded = false
  }
}
