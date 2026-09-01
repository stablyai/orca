import type { PersistedAgentLaunchFailure } from '../../../../../shared/agent-launch-contract'
import type { DispatchContextRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

export type DispatchLaunchIdentity = {
  requestedAgent: string | null
  baseAgent: string | null
}

export function forgetDispatch(this: OrchestrationDb, ctxId: string): DispatchContextRow | undefined {
  const ctx = this.getDispatchContextById(ctxId)
  if (!ctx || ctx.status !== 'dispatched') {
    return undefined
  }
  this.db.prepare("UPDATE dispatch_contexts SET status = 'forgotten' WHERE id = ?").run(ctxId)
  this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(ctx.task_id)
  return this.getDispatchContextById(ctxId)
}

export function clearDispatchLaunchFailure(
  this: OrchestrationDb,
  ctxId: string
): DispatchContextRow | undefined {
  this.db
    .prepare('UPDATE dispatch_contexts SET agent_launch_failure = NULL WHERE id = ?')
    .run(ctxId)
  return this.getDispatchContextById(ctxId)
}

export function markDispatchLaunchUnknown(
  this: OrchestrationDb,
  ctxId: string,
  failure: PersistedAgentLaunchFailure
): DispatchContextRow | undefined {
  let persisted = failure
  const ctx = this.getDispatchContextById(ctxId)
  if (!ctx) {
    return undefined
  }
  if (ctx.agent_launch_failure) {
    try {
      const existing = JSON.parse(ctx.agent_launch_failure) as PersistedAgentLaunchFailure
      if (existing.code === 'launch_state_unknown' && typeof existing.failureId === 'string') {
        persisted = { ...failure, failureId: existing.failureId }
      }
    } catch {
      // Malformed/legacy blob — replace it with the fresh card.
    }
  }
  this.db
    .prepare('UPDATE dispatch_contexts SET agent_launch_failure = ? WHERE id = ?')
    .run(JSON.stringify(persisted), ctxId)
  return this.getDispatchContextById(ctxId)
}

export function referencedRequestedAgents(this: OrchestrationDb): string[] {
  const rows = this.db
    .prepare('SELECT requested_agent FROM dispatch_contexts WHERE requested_agent IS NOT NULL')
    .all() as { requested_agent: string }[]
  return rows.map((row) => row.requested_agent)
}

export type DispatchLaunchIdentityMethods = {
  forgetDispatch: typeof forgetDispatch
  clearDispatchLaunchFailure: typeof clearDispatchLaunchFailure
  markDispatchLaunchUnknown: typeof markDispatchLaunchUnknown
  referencedRequestedAgents: typeof referencedRequestedAgents
}

export function attachDispatchLaunchIdentity(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    forgetDispatch,
    clearDispatchLaunchFailure,
    markDispatchLaunchUnknown,
    referencedRequestedAgents
  })
}
