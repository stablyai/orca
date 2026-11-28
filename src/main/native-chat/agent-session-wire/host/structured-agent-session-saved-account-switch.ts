// A new selected saved account reaches every chat of an agent whose saved accounts share one home
// (agy's): idle ones stop now and start on it at their next send; one still running a turn
// finishes that turn on its account and says so in the chat, in one note it revises as the
// selection moves and removes once the selection is back on its account.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { releaseIdleChatsOnOtherAccount } from './structured-agent-session-account-switch'
import {
  removeStructuredAgentSessionOrcaNote,
  writeStructuredAgentSessionOrcaNote
} from '../structured-agent-session-orca-note'
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

// Per host, the note each chat's running agent carries: its id, which names that agent's fence.
const runningNotes = new WeakMap<object, Map<string, string>>()

const warn = (error: unknown): void =>
  console.warn('[structured-agent-session] a chat was not told about its account:', error)

export async function moveChatsToSelectedAccount(
  host: SwitchHost | null,
  agent: string,
  /** The account a running chat should be on now (null: unknown, or moving there fails), and a
   *  key's email. */
  selection: { target(): string | null; email(key: string): string | null },
  committed: () => boolean
): Promise<void> {
  if (!host) {
    return
  }
  await releaseIdleChatsOnOtherAccount(host, agent, committed)
  const to = selection.target()
  if (to === null || !committed()) {
    return
  }
  const notes = runningNotes.get(host) ?? new Map<string, string>()
  runningNotes.set(host, notes)
  await Promise.all(
    host.loadedSessionIds().map(async (sessionId) => {
      const from = host.sessionAgent(sessionId) === agent && host.reads.childAccountKey(sessionId)
      // No account selected when it launched: it ran on whatever login agy held, so nothing to name.
      if (!from) {
        return
      }
      const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
      const id = `account-switch:${fence}`
      if (from === to) {
        if (notes.get(sessionId) === id) {
          notes.delete(sessionId)
          await removeStructuredAgentSessionOrcaNote(host, sessionId, id).catch(warn)
        }
        return
      }
      notes.set(sessionId, id)
      const notice = {
        from: selection.email(from) ?? 'the previous account',
        to: selection.email(to) ?? 'the selected account'
      }
      await writeStructuredAgentSessionOrcaNote(
        host,
        sessionId,
        id,
        agentAccountSwitchRow(notice)
      ).catch(warn)
    })
  )
}

/** A chat that started on another account than the selected one it was prepared for says why. */
export async function noteChatNotMovedToAccount(
  host: Pick<StructuredAgentSessionHost, 'deps' | 'conversation'> | null,
  chat: { sessionId: string; to: string; reason: string }
): Promise<void> {
  if (!host) {
    return
  }
  const fence = host.deps.store.getRecord(chat.sessionId)?.lease.runtimeFence ?? 0
  await writeStructuredAgentSessionOrcaNote(
    host,
    chat.sessionId,
    `account-not-moved:${fence}`,
    agentAccountSwitchRow({ to: chat.to, reason: chat.reason })
  ).catch(warn)
}
