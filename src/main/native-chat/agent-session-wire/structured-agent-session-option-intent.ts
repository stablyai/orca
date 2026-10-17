import { refuse, type AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes
} from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Whether the agent takes this pick: a permission mode it offers, or an option key it names. */
function acceptsOptionPick(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  provider: string,
  key: string,
  value: string
): boolean {
  const definition = agents.definition(provider)
  return key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
    ? definition !== null &&
        agentChatPermissionModes(provider)?.modes.some((mode) => mode === value) === true
    : definition?.restingOptions.acceptsKey(key) === true
}

/** Initial explicit picks follow the same rules as a pick made while the chat is at rest. */
export function structuredAgentSessionOptionOverridesRefusal(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  provider: string,
  options: Readonly<Record<string, string>>
) {
  const key = Object.keys(options).find(
    (key) => !acceptsOptionPick(agents, provider, key, options[key] ?? '')
  )
  return key === undefined
    ? null
    : refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        `${provider} has no session option named ${key}`
      )
}

/** Records a pick for the next start. Only a key the provider would accept is kept. */
export async function recordStructuredAgentSessionOptionIntent(
  deps: {
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'replaceSessionOptions'>
    agents: Pick<StructuredAgentRegistry, 'definition'>
  },
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'persistOptions' | 'publish' | 'now'>,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const record = deps.store.getRecord(ctx.sessionId)
  if (!record || !acceptsOptionPick(deps.agents, record.provider, input.key, input.value)) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        `${record?.provider ?? 'This session'} has no session option named ${input.key}`
      )
    }
  }
  const options = { ...record.options, [input.key]: input.value }
  // The answer still names the mode among the options, as the wire always has.
  await (input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
    ? deps.store.replaceSessionOptions({
        sessionId: ctx.sessionId,
        fence: ctx.fence,
        permissionMode: input.value,
        now: ctx.now()
      })
    : ctx.persistOptions(options))
  ctx.publish()
  return { ok: true, value: { ...input, options } }
}
