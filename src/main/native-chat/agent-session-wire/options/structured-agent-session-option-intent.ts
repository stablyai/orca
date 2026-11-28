import {
  IN_PROCESS_OPTIONS_READER,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-resting-options'
import {
  isAgentSessionRefusalError,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session/agent-session-wire'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type {
  AgentSessionTurnContext,
  TurnOutcome
} from '../operations/structured-agent-session-turns'
import { isAgentSessionInteractionMode } from '../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import { structuredAgentSessionPickReply } from './structured-agent-session-pick-reply'

function acceptsOptionPick(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  provider: string,
  key: string,
  value: string
): boolean {
  const definition = agents.definition(provider)
  return key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
    ? definition !== null &&
        agentChatPermissionModes(provider) !== null &&
        (value === 'own' ||
          agentChatPermissionModes(provider)?.modes.some((mode) => mode === value) === true)
    : definition?.restingOptions.acceptsKey(key) === true &&
        (key !== 'interactionMode' || isAgentSessionInteractionMode(value))
}

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

/** Records literal picks for registered keys; the native control owns value acceptance. */
export async function recordStructuredAgentSessionOptionIntent(
  { deps, startFlights }: Pick<StructuredAgentSessionMutationContext, 'deps' | 'startFlights'>,
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'fence' | 'journal' | 'publish' | 'now'>,
  input: { key: string; value: string },
  reader: StructuredAgentSessionOptionsReader = IN_PROCESS_OPTIONS_READER
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
  if (!reader.readsWithoutModel && input.key === 'model' && input.value === '') {
    return { ok: true, value: { key: input.key, value: input.value, options: {} } }
  }
  let options: Readonly<Record<string, string>>
  if (input.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    const permissionMode = input.value
    await deps.store.replaceSessionOptions({ sessionId, fence, permissionMode, now: ctx.now() })
    // Preserve the wire’s permission mode within options.
    options = { ...record.options, [input.key]: input.value }
  } else {
    // Send admission captures the model before the startup reservation reaches the record store.
    const startupPending =
      input.key === 'model' &&
      record.provider === 'codex' &&
      record.providerHandleChain.length === 0 &&
      record.lease.claimStatus === 'released' &&
      (startFlights.get(sessionId) !== undefined ||
        (await ctx.journal.reads.input({ kind: 'first-queued' })).submission !== undefined)
    const picked = { sessionId, fence, ...input, models: undefined, startupPending, now: ctx.now() }
    try {
      options =
        (await deps.store.updateRecord(sessionId, { kind: 'pick-option', args: picked })).options ??
        {}
    } catch (error) {
      if (
        isAgentSessionRefusalError(error) &&
        error.refusal.code === 'agent_session_operation_invalid'
      ) {
        return { ok: false, refusal: error.refusal }
      }
      throw error
    }
  }
  ctx.publish()
  return {
    ok: true,
    value: {
      ...input,
      options:
        deps.adapter.projectOptions?.(sessionId, options)?.options ??
        structuredAgentSessionPickReply(options, undefined)
    }
  }
}
