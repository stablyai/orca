import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const MESSAGE: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey('op-undelivered'),
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'never got it' }] }
}

/** Handed over, then the agent's history showed it never got it. */
const UNDELIVERED: AgentJournalSubmission = {
  clientMessageId: 'op-undelivered',
  fence: 3,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  submittedAt: 1,
  resolvedAt: 2,
  handoverRecorded: true,
  handedOverAt: 1,
  recovered: true,
  ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), { surface: 'rejection' })
}

/** A Codex hook blocked it: a rejection of its own kind, with the host's sentence beside it. */
const HOOK_BLOCKED: AgentJournalSubmission = {
  ...UNDELIVERED,
  ...agentSessionFailureWords(
    agentSessionFailureFact('hookBlocked', {
      detail: { text: 'No secrets in prompts.', audience: 'person' }
    }),
    { surface: 'rejection', agentName: 'Codex' }
  )
}

function snapshot(submission: AgentJournalSubmission = UNDELIVERED): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: [MESSAGE],
      removedItemIds: [],
      submissions: [submission],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: 1 },
        nextCursor: { epoch: 'epoch-1', sequence: 2 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 1 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

// Module scope: the harness assigns these, which a test body's own `let` would narrow to null.
let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
let listener: ((value: unknown) => void) | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
  listener = null
})

/** The messages the phone's chat draws once the host's page holds this submission. */
async function phoneMessages(submission: AgentJournalSubmission) {
  const client: RpcClient = {
    sendRequest: async () => ({
      id: 'request-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    }),
    subscribe: (_method, _params, onData) => {
      listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'claude',
      hostSupport: null,
      onSendError: vi.fn()
    })
    return null
  }

  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  act(() => listener?.(snapshot(submission)))
  return hook?.session.messages
}

// The phone does not mark a message as unsent yet; drawn, it would look delivered.
it('keeps a message the agent never got hidden, as before', async () => {
  expect(await phoneMessages(UNDELIVERED)).toEqual([])
})

// Before the block was known it was drawn as sent; it stays so rather than vanish.
it('draws a message a Codex hook blocked as sent, as before', async () => {
  const messages = await phoneMessages(HOOK_BLOCKED)
  expect(messages?.map(({ id }) => id)).toEqual([agentJournalSubmissionKey('op-undelivered')])
  expect(messages?.[0]).not.toHaveProperty('unsent')
})
