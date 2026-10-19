// A message's model and effort, applied to the turn it starts the way a picker change is applied.

import type { AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { performSetOption } from './structured-agent-session-turns-options'
import type { TurnOutcome } from './structured-agent-session-turns'

/** With no child running, intent the next start replays; else the running child's own write. Either
 *  is recorded on the chat at `fence` and published. */
export async function writeStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  target: { sessionId: string; fence: number },
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const { sessionId, fence } = target
  const session = context.sessions.get(sessionId)
  const ctx = {
    sessionId,
    fence,
    now: () => context.now(),
    adapter: context.deps.adapter,
    persistOptions: (options: Readonly<Record<string, string>>) =>
      context.deps.store
        .replaceSessionOptions({ sessionId, fence, options, now: context.now() })
        .then(() => undefined),
    publish: () => session && context.publish(sessionId, session.journal)
  }
  const child = session?.child
  if (
    input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ||
    !child ||
    child.phase === 'starting' ||
    child.close !== undefined
  ) {
    return recordStructuredAgentSessionOptionIntent(context.deps, ctx, input)
  }
  // Held where a start is, so a close, a Stop admitted now or quit ends the wait from outside.
  const wait = context.acquireAborts.begin(sessionId)
  try {
    return await performSetOption(ctx, input, wait.signal)
  } finally {
    wait.end()
  }
}

/** A message's model and effort, applied as it is handed over or its agent starts for it: model
 *  first, so the effort lands under it, and a value the chat already holds writes nothing. A failed
 *  write is logged and never stops the message, which runs on what the chat holds. */
export async function applyStructuredAgentSessionMessageOptions(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  options: Readonly<Record<string, string>> | undefined
): Promise<void> {
  const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence
  if (!options || fence === undefined) {
    return
  }
  const entries = Object.entries(options).sort(
    ([a], [b]) => Number(b === 'model') - Number(a === 'model')
  )
  for (const [key, value] of entries) {
    if (context.deps.store.getRecord(sessionId)?.options?.[key] === value) {
      continue
    }
    const written = await writeStructuredAgentSessionOption(
      context,
      { sessionId, fence },
      { key, value }
    ).catch((error: unknown) => ({ ok: false as const, error }))
    if (!written.ok) {
      context.deps.logger.warn("applying a message's option failed", {
        scope: 'message-options',
        sessionId,
        key,
        error: 'error' in written ? written.error : written.refusal
      })
    }
  }
}
