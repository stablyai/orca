import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import {
  isNativeProviderCommand,
  prepareStructuredChatProviderSwitchPrompt
} from './structured-agent-session-provider-handover'
import {
  isCurrentProviderSwitch,
  type ProviderSelectionHost
} from './structured-agent-session-provider-selection'
import {
  prepareStructuredChatProviderSwitch,
  recordProviderHandoff,
  setProviderSwitchSessionParams
} from './structured-agent-session-provider-switch'

export function wireStructuredChatProviderSwitch(
  host: ProviderSelectionHost & {
    hasWork: (id: string, submission: AgentJournalSubmission) => Promise<boolean>
    stop: (id: string) => Promise<void>
  }
): Pick<
  StructuredAgentSessionDeliveryLoopDeps,
  | 'prepareProviderSwitch'
  | 'settleProviderSwitch'
  | 'prepareProviderSwitchPrompt'
  | 'reconcileProviderSwitch'
> {
  const settleProviderSwitch: NonNullable<
    StructuredAgentSessionDeliveryLoopDeps['settleProviderSwitch']
  > = async (session, clientMessageId, outcome) => {
    const id = session.params.envelope.sessionId
    const current = host.deps.store.getRecord(id)
    const switching = current?.providerSwitch
    if (!current || switching?.clientMessageId !== clientMessageId) {
      return
    }
    if (outcome === 'failed' && session.child) {
      await host.stop(id)
    }
    const item =
      outcome === 'delivered'
        ? await session.journal.reads.item(agentJournalSubmissionKey(clientMessageId))
        : undefined
    // Handover moves the command's journal row after the original switch cut.
    const deferContextThrough =
      item?.body.kind === 'message' &&
      isNativeProviderCommand(item.body, current.provider, host.deps.adapter.readCommands?.(id))
        ? { ...switching.through, sequence: Math.max(switching.through.sequence, item.sequence) }
        : undefined
    const record = await host.deps.store.updateRecord(id, {
      kind: 'settle-provider-switch',
      clientMessageId,
      outcome,
      now: host.now(),
      ...(deferContextThrough ? { deferContextThrough } : {})
    })
    setProviderSwitchSessionParams(session, record)
    if (outcome === 'failed') {
      await recordProviderHandoff(session, current, record.lease.runtimeFence, true)
    }
    host.publish(id)
  }
  return {
    reconcileProviderSwitch: async (session, clientMessageId) => {
      const record = host.deps.store.getRecord(session.params.envelope.sessionId)
      const switching = record?.providerSwitch
      if (!switching || isCurrentProviderSwitch(host.deps, record, clientMessageId)) {
        return 'current'
      }
      const original = await session.journal.reads.submission(switching.clientMessageId)
      if (
        original?.dispatchState === 'pending' &&
        original.handedOverAt !== undefined &&
        isCurrentProviderSwitch(host.deps, record, switching.clientMessageId) &&
        session.child &&
        !session.child.close
      ) {
        return 'park'
      }
      await settleProviderSwitch(
        session,
        switching.clientMessageId,
        original?.dispatchState === 'accepted' ? 'delivered' : 'failed'
      )
      return 'settled'
    },
    prepareProviderSwitch: (session, submission) => {
      const id = session.params.envelope.sessionId
      return prepareStructuredChatProviderSwitch(
        host,
        session,
        submission,
        () => host.hasWork(id, submission),
        () => host.stop(id)
      )
    },
    settleProviderSwitch,
    prepareProviderSwitchPrompt: (session, clientMessageId) =>
      prepareStructuredChatProviderSwitchPrompt(host.deps, session, clientMessageId)
  }
}
