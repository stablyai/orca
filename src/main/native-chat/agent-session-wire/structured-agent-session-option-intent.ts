// A pick is kept only when the chat's agent takes it, and is recorded as intent for the next start.

import { refuse, type AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes
} from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import {
  savedAgentSessionCatalogModels,
  structuredAgentSessionPickReply
} from './structured-agent-session-pick-reply'
import { pickAgentSessionOption } from '../../runtime/agent-session-record-options'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

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

/** Records a pick for the next start. Only a key the provider would accept is kept, and only a
 *  value the chat's model runs; a model pick drops an inherited effort or Fast it doesn't. */
export async function recordStructuredAgentSessionOptionIntent(
  deps: {
    store: Pick<
      AgentSessionRecordStore,
      'getRecord' | 'replaceSessionOptions' | 'reviseSessionOptions'
    >
    agents: Pick<StructuredAgentRegistry, 'definition'>
  } & Parameters<typeof savedAgentSessionCatalogModels>[0],
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'publish' | 'now'>,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const { sessionId, fence } = ctx
  const record = deps.store.getRecord(sessionId)
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
  const models = await savedAgentSessionCatalogModels(deps, record.provider, sessionId)
  let options: Readonly<Record<string, string>>
  if (input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    const permissionMode = input.value
    await deps.store.replaceSessionOptions({ sessionId, fence, permissionMode, now: ctx.now() })
    // The answer still names the mode among the options, as the wire always has.
    options = { ...record.options, [input.key]: input.value }
  } else {
    const picked = { sessionId, fence, ...input, models, now: ctx.now() }
    try {
      options =
        (await deps.store.reviseSessionOptions(pickAgentSessionOption, picked)).options ?? {}
    } catch (error) {
      // The ordered write refused a value the chat's model doesn't offer.
      if (isAgentSessionRefusalError(error)) {
        return { ok: false, refusal: error.refusal }
      }
      throw error
    }
  }
  ctx.publish()
  return {
    ok: true,
    value: { ...input, options: structuredAgentSessionPickReply(options, models) }
  }
}
