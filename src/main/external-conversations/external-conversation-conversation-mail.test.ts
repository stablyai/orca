import { describe, expect, it } from 'vitest'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isConversationReport } from './external-conversation-turn-opener'

const OTHER_CHAT = 'orca_session_id:22222222-2222-4222-8222-222222222222'

function opener(mailbox: string, senders: AgentMessageSender[]): AgentJournalRenderItem['body'] {
  const from: AgentMessageSource = {
    kind: 'agent',
    senders,
    orchestration: {
      message: 'mail-notice',
      mailbox,
      dispatchId: null,
      messages: [{ messageId: 'm1', runId: 'r1', from: senders[0]?.party.address ?? 'x' }]
    }
  }
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'mail' }], from }
}

const sender = (
  address: string,
  relation?: AgentMessageSender['relation'],
  toConversation = relation === 'worker'
): AgentMessageSender => ({
  party: { address, terminalHandle: null, orcaSessionId: null },
  name: 'Sender',
  ...(relation ? { relation } : {}),
  ...(toConversation ? { toConversation: true as const } : {})
})

describe('isConversationReport', () => {
  it('is not mail whose sender Orca cannot prove is such a worker: another bot, item mail', () => {
    expect(isConversationReport(opener('run:r1', [sender(OTHER_CHAT)]))).toBe(false)
    expect(isConversationReport(opener('run:r1', [sender(OTHER_CHAT, 'none')]))).toBe(false)
    expect(isConversationReport(opener('run:r1', []))).toBe(false)
    expect(isConversationReport(opener(OTHER_CHAT, [sender('dispatch:d1', 'worker')]))).toBe(false)
    expect(isConversationReport(opener(OTHER_CHAT, [sender(OTHER_CHAT, 'none')]))).toBe(false)
  })

  it("is a wait's run only when the wait was made by a turn its conversation owned", () => {
    const waitRun = (toConversation: boolean): AgentJournalRenderItem['body'] => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'The run finished.' }],
      origin: 'automation-run',
      automationRun: {
        runId: 'run-1',
        automation: {
          id: 'wait-1',
          name: 'Run 44228520011',
          enabled: true,
          nextRunAt: 0,
          updatedAt: 0,
          dtstart: 0,
          rrule: 'FREQ=DAILY',
          workspaceId: 'folder:f1'
        },
        trigger: 'event',
        wait: { kind: 'event', at: 1 },
        ...(toConversation ? { toConversation: true as const } : {}),
        instructionsLength: 0
      }
    })
    expect(isConversationReport(waitRun(true))).toBe(true)
    expect(isConversationReport(waitRun(false))).toBe(false)
  })
})
