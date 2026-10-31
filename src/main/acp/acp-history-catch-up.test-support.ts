import { vi } from 'vitest'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { AcpHistoryTurnIdentity, AcpLoadHistoryFrame } from './acp-history-replay'
import {
  AGENT,
  NAMESPACE,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { catchUpAcpHistory } from './acp-history-catch-up'

export async function setup(dialect: AcpDialect, identity: AcpHistoryTurnIdentity) {
  const fixture = await openAcpFixtureRig(dialect)
  const warn = vi.fn<StructuredAgentSessionLogger['warn']>()
  const catchUp = (frames: readonly AcpLoadHistoryFrame[]) =>
    catchUpAcpHistory({
      frames,
      identity,
      sink: fixture.rig.eventSink,
      sessionId: SESSION,
      agent: AGENT,
      providerSessionId: NAMESPACE,
      dialect,
      logger: { warn, error: vi.fn() },
      assertCurrent: () => {}
    })
  return { fixture, catchUp, warn }
}

export function dividers(rows: AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return rows.filter(
    (row) =>
      row.body.kind === 'status' &&
      ['history-loaded', 'continued-outside', 'continued-outside-rewound'].includes(
        row.body.presentation ?? ''
      )
  )
}

/** The chat's own send, as its row reads: the text a person typed. */
export async function chatSend(
  fixture: Awaited<ReturnType<typeof openAcpFixtureRig>>,
  clientMessageId: string,
  text: string
) {
  const identity = parseAgentJournalItemKey(agentJournalSubmissionKey(clientMessageId))!
  await fixture.rig.journal.appendItem(
    identity,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
}

export function replayUpdate(
  sessionUpdate: string,
  rest: Record<string, unknown> = {}
): AcpLoadHistoryFrame {
  return {
    method: 'session/update',
    params: { sessionId: NAMESPACE, update: { sessionUpdate, ...rest } }
  }
}
export const userReplay = (id: string, text = 'repeat') =>
  replayUpdate('user_message_chunk', {
    messageId: id,
    content: { type: 'text', text }
  })
export const answerReplay = (text: string, id = 'answer') =>
  replayUpdate('agent_message_chunk', {
    messageId: id,
    content: { type: 'text', text }
  })
