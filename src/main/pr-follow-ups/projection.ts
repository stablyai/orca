import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../shared/agent-session/agent-session-host-authority'
import type { FollowUpSnapshot } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
import { followUpView, FOLLOW_UP_DAY, type FollowUpProjection } from './follow-up-state'
import { readFollowUpActivity } from './action-lifecycle'

export function createFollowUpProjectionState() {
  return {
    inventoryProjection: '',
    publishedInventory: '',
    entries: new Map<string, FollowUpSnapshot['workspaces'][string]>(),
    recoveryDeadlines: new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>(),
    identityPrKeys: new Map<string, string>(),
    activeKeys: new Set<string>(),
    observations: new Map<string, string>(),
    projections: new Map<string, FollowUpProjection>(),
    published: new Map<string, string>(),
    windowHolds: new Map<string, string>()
  }
}

export function publishFollowUpProjection(
  deps: FollowUpEngineDependencies,
  state: ReturnType<typeof createFollowUpProjectionState>,
  keys: Iterable<string>,
  reconcile: (keys: string[]) => Promise<void>
): void {
  const affected = [...new Set(keys)]
  let changed = state.publishedInventory !== state.inventoryProjection
  state.publishedInventory = state.inventoryProjection
  for (const key of affected) {
    const store = deps.store
    const pr = store.pr(key)
    const projection: FollowUpProjection = {
      pr,
      observation: deps.source.latest(key),
      latestAction: store.latestAction(key),
      pending: store.actions(key, true),
      used: pr ? store.acceptedCount(key, pr.generation) : 0,
      recentStarts: store.recentAcceptedStarts(key, (deps.now?.() ?? Date.now()) - FOLLOW_UP_DAY),
      waitingForWindow: state.windowHolds.get(key)
    }
    state.projections.set(key, projection)
    const { pending } = projection
    for (const action of pending) {
      for (const identity of [action.sessionId, action.paneKey, action.terminalPtyId]) {
        if (identity) {
          state.identityPrKeys.set(identity, key)
        }
      }
    }
    if (pending.length) {
      state.activeKeys.add(key)
    } else {
      state.activeKeys.delete(key)
    }
    const at = Math.min(
      ...pending
        .filter((action) => action.status === 'claimed' || action.status === 'unconfirmed')
        .map((action) => action.attemptStartedAt + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS)
    )
    const previous = state.recoveryDeadlines.get(key)
    if (previous?.at !== at) {
      if (previous) {
        clearTimeout(previous.timer)
      }
      state.recoveryDeadlines.delete(key)
      if (Number.isFinite(at)) {
        const timer = setTimeout(
          () => {
            void reconcile([key]).catch((error) =>
              console.error('[pr-follow-ups] receipt deadline failed', error)
            )
          },
          Math.max(1, at - (deps.now?.() ?? Date.now()))
        )
        timer.unref?.()
        state.recoveryDeadlines.set(key, { at, timer })
      }
    }
    const fixing = new Set(
      pending
        .filter(
          (action) =>
            action.status === 'accepted' && readFollowUpActivity(deps, action).working === true
        )
        .map((action) => action.worktreeId)
    )
    const values = deps.targets(key).map(
      (target) =>
        [
          target.worktreeId,
          {
            prKey: key,
            view: followUpView(projection, deps.globalSettings(), target),
            fixing: fixing.has(target.worktreeId)
          }
        ] as const
    )
    const serialized = JSON.stringify(values)
    for (const [id, value] of values) {
      state.entries.set(id, value)
    }
    if (state.published.get(key) !== serialized) {
      state.published.set(key, serialized)
      changed = true
    }
    if (!values.length && !pr) {
      state.observations.delete(key)
      state.projections.delete(key)
      state.published.delete(key)
    }
  }
  if (changed) {
    deps.changed?.(affected)
  }
}
