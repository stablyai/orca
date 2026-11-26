import { randomUUID } from 'node:crypto'
import {
  isAgentChatPermissionChoice,
  type AgentChatPermissionChoice
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  providerSwitchPermission,
  type AgentSessionSelectProviderParams,
  type AgentSessionSelectProviderResult
} from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { adapterSupportsCreateIfDeclared } from '../providers/structured-agent-session-provider-support'
import { structuredAgentSessionOptionOverridesRefusal } from '../options/structured-agent-session-option-intent'

// A crash before the handoff must leave the next send subject to a fresh confirmation.
const providerSwitchRunIds = new WeakMap<StructuredAgentSessionHostDeps, string>()

export function providerSwitchHostRunId(deps: StructuredAgentSessionHostDeps): string {
  const current = providerSwitchRunIds.get(deps)
  if (current) {
    return current
  }
  const run = randomUUID()
  providerSwitchRunIds.set(deps, run)
  return run
}

export type ProviderSelectionHost = {
  deps: StructuredAgentSessionHostDeps
  publish: (sessionId: string) => void
  now: () => number
}

export function providerSwitchSourcePermission(
  record: Pick<AgentSessionRecord, 'permissionMode'>
): AgentChatPermissionChoice {
  return isAgentChatPermissionChoice(record.permissionMode) ? record.permissionMode : 'ask'
}

/** The current reply owns the child until delivery chooses a fresh turn. */
export async function selectStructuredChatProvider(
  host: Pick<ProviderSelectionHost, 'deps' | 'now'>,
  session: StructuredAgentSessionHostSession,
  { sessionId, agent, options, consent }: AgentSessionSelectProviderParams,
  botDefault?: string
): Promise<AgentSessionSelectProviderResult> {
  const { deps } = host
  const record = deps.store.requireWritableRecord(sessionId)
  const selection = {
    agent,
    ...(options ? { options } : {}),
    ...(botDefault ? { botDefault } : {})
  }
  if (agent !== record.provider) {
    if (
      !deps.resolveProviderSwitchAccount ||
      !deps.agents.definition(agent) ||
      deps.canSwitchProvider?.(sessionId, agent) === false ||
      !adapterSupportsCreateIfDeclared(deps.adapter, record.location, agent)
    ) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const refusal =
      options && structuredAgentSessionOptionOverridesRefusal(deps.agents, agent, options)
    if (refusal) {
      throw new AgentSessionRefusalError(refusal)
    }
    const fromPermission = providerSwitchSourcePermission(record)
    if (providerSwitchPermission(fromPermission, agent).requiresConsent) {
      const previous = record.selectedProvider
      const previousConsent = previous?.consent
      const cursor = await session.journal.reads.cursor()
      if (
        !consent &&
        previous?.agent === agent &&
        previousConsent?.from === record.provider &&
        previousConsent.fromPermission === fromPermission &&
        previousConsent.hostRunId === providerSwitchHostRunId(deps) &&
        previousConsent.through.epoch === cursor.epoch
      ) {
        await deps.store.updateRecord(sessionId, {
          kind: 'select-provider',
          selection: { ...selection, consent: previousConsent },
          now: host.now()
        })
        return { status: 'selected' }
      }
      if (
        consent?.from !== record.provider ||
        consent.fromPermission !== fromPermission ||
        consent.permission !== 'full-access'
      ) {
        return { status: 'consent-required', from: record.provider, fromPermission }
      }
      await deps.store.updateRecord(sessionId, {
        kind: 'select-provider',
        selection: {
          ...selection,
          consent: {
            from: record.provider,
            fromPermission,
            hostRunId: providerSwitchHostRunId(deps),
            through: cursor
          }
        },
        now: host.now()
      })
      return { status: 'selected' }
    }
  }
  await deps.store.updateRecord(sessionId, { kind: 'select-provider', selection, now: host.now() })
  return { status: 'selected' }
}
