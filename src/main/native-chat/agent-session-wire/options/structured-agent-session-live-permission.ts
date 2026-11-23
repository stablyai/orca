import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import { structuredAgentSessionImmediatePermission } from './structured-agent-session-launch-permission'

/** Hands the chat's saved mode to its running agent; one that cannot switch takes it with the next send. */
export function applyStructuredAgentSessionPermissionPick(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'sessions' | 'trackProviderOperation'
  >,
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'publish' | 'logger'>
): void {
  const { sessionId, fence } = ctx
  const { adapter, store } = context.deps
  const child = context.sessions.get(sessionId)?.child
  const record = store.getRecord(sessionId)
  const mode = record ? structuredAgentSessionImmediatePermission(context.deps, record) : null
  if (
    !adapter.applyPermissionMode ||
    !mode ||
    child?.phase !== 'ready' ||
    child.close ||
    child.fence !== fence
  ) {
    return
  }
  const applying = adapter.applyPermissionMode({ sessionId, fence, mode }).then(
    () => ctx.publish(),
    (error: unknown) =>
      ctx.logger.warn('applying a permission pick to the running agent failed', {
        scope: 'live-permission',
        sessionId,
        error
      })
  )
  context.trackProviderOperation?.(applying)
}
