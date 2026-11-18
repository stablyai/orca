import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { finishTurn } from './external-conversation-provider-turn.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import {
  attach,
  hostTestState
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import { harness, installedChats } from './external-conversation-seam.test-fixture'
import { WORKTREE } from './external-conversation.test-fixture'

// A bot's thread chat answers in the thread only mail that came from it: its thread's workers' reports.
const mail = (
  sender: AgentMessageSource['senders'][number],
  mailbox: string
): AgentMessageSource => ({
  kind: 'agent',
  senders: [sender],
  orchestration: {
    message: 'mail-notice',
    mailbox,
    dispatchId: null,
    messages: [{ messageId: 'm2', runId: 'r2', from: sender.party.address }]
  }
})
const REVIEW_MAIL = mail(
  {
    party: { address: 'dispatch:reviewer', terminalHandle: null, orcaSessionId: null },
    name: 'Eng - Reviewer',
    relation: 'none'
  },
  'dispatch:bot'
)
const THREAD_WORKER_REPORT = mail(
  {
    party: { address: 'dispatch:worker', terminalHandle: null, orcaSessionId: null },
    name: 'Worker',
    relation: 'worker',
    toConversation: true
  },
  'run:r2'
)

beforeEach(() => {
  // The host refuses operation ids minted far from its own clock.
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

it("keeps a turn another bot's mail woke in Orca, and posts its thread's worker reports", async () => {
  const { host } = hostTestState()
  await attach()
  const h = harness()
  h.seam.linkChat(
    { source: 'slack', externalId: 'T1:C9:2' },
    {
      worktreeId: WORKTREE,
      sessionId: HOST_TEST_SESSION,
      agent: 'claude',
      bot: { kind: 'bot', botId: 'b1' }
    }
  )
  const events: (ConversationEvent | ConversationSnapshot)[] = []
  h.seam.watch({ chat: installedChats(host).chats }, (event) => events.push(event))
  const posted = () =>
    events.filter((event) => event.kind === 'turn-ended' && event.lastAssistantMessage)

  await finishTurn('Plan B is reviewed; building it now.', { opener: REVIEW_MAIL })
  await finishTurn('The fix is merged.', { opener: THREAD_WORKER_REPORT, turnId: 'turn-2' })
  await eventually(() => expect(posted()).toHaveLength(1))
  expect(posted()[0]).toMatchObject({
    origin: 'delivery',
    lastAssistantMessage: 'The fix is merged.'
  })
})
