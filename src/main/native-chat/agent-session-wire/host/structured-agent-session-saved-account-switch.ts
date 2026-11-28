// A new selected saved account reaches every chat of an agent whose saved accounts share one home
// (agy's): idle ones stop now and start on it at their next send; one still running a turn
// finishes that turn on its account and says so in the chat.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { releaseIdleChatsOnOtherAccount } from './structured-agent-session-account-switch'
import { writeStructuredAgentSessionOrcaNote } from '../structured-agent-session-orca-note'
import {
  boundPayload,
  PROVIDER_FRAME_PAYLOAD_LIMITS
} from '../../agent-session-journal/item-lifecycle/journal-payload-bounds'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import {
  AGENT_ACCOUNT_SWITCH_FRAME_KIND,
  agentAccountSwitchText,
  type AgentAccountSwitchNotice
} from '../../../../shared/native-chat/transcript/notices/agent-account-switch-notice'
import type { AgentJournalPlainStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

type SwitchHost = Parameters<typeof releaseIdleChatsOnOtherAccount>[0] &
  Pick<StructuredAgentSessionHost, 'deps' | 'conversation'> & {
    reads: Pick<StructuredAgentSessionHost['reads'], 'childAccountKey'>
  }

export function agentAccountSwitchRow(
  notice: AgentAccountSwitchNotice
): AgentJournalPlainStatusItem {
  return {
    kind: 'status',
    text: agentAccountSwitchText(notice),
    tone: 'notice',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    providerFrame: {
      provider: 'orca',
      kind: AGENT_ACCOUNT_SWITCH_FRAME_KIND,
      payload: boundPayload(JSON.stringify(notice), PROVIDER_FRAME_PAYLOAD_LIMITS)
    }
  }
}

export async function moveChatsToSelectedAccount(
  host: SwitchHost | null,
  agent: string,
  /** The selected saved account's key now (null: unknown), and a key's email. */
  selection: { current(): string | null; email(key: string): string | null },
  committed: () => boolean
): Promise<void> {
  if (!host) {
    return
  }
  await releaseIdleChatsOnOtherAccount(host, agent, committed)
  const to = selection.current()
  if (to === null || !committed()) {
    return
  }
  await Promise.all(
    host.loadedSessionIds().map(async (sessionId) => {
      const from = host.sessionAgent(sessionId) === agent && host.reads.childAccountKey(sessionId)
      if (from === false || from === undefined || from === to) {
        return
      }
      const notice = {
        from: selection.email(from) ?? 'the previous account',
        to: selection.email(to) ?? 'the selected account'
      }
      // One note per chat and account pair: switching there and back revises it in place.
      await writeStructuredAgentSessionOrcaNote(
        host,
        sessionId,
        `account-switch:${from}:${to}`,
        agentAccountSwitchRow(notice)
      ).catch((error: unknown) =>
        console.warn(
          '[structured-agent-session] a chat finishing on its previous account was not told:',
          error
        )
      )
    })
  )
}
