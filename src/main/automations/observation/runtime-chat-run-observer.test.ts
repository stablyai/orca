import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { automationRunOperationId } from '../launch/automation-run-operation'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { reserveGroupTurns } from '../../bots/bot-group-turn-reservation'
import type { BotGroupRuntime } from '../../bots/bot-group-runtime'
import type { BotGroup } from '../../../shared/bots/bot-group'
import type { Bot } from '../../../shared/bot-types'

// After a restart: a run that sends its own prompt is found by its run-derived message id, in a chat
// or a room; one sent before those ids existed settles failed once its chat is idle; a launched Chat
// run still needs its launch receipt.
const NOW = Date.parse('2026-11-25T09:00:00Z')
const run: AutomationRun = {
  id: 'run-7',
  automationId: 'auto-1',
  title: 'Daily report',
  scheduledFor: NOW,
  status: 'dispatched',
  trigger: 'manual',
  workspaceId: 'ws-1',
  sessionKind: 'chat',
  chatSessionId: 'chat-1',
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: NOW,
  dispatchedAt: NOW,
  createdAt: NOW
}

function chatWith(messageId: string, outcome: 'success' | 'failure'): AgentJournalSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the run read uses
  return {
    sessionId: 'chat-1',
    cursor: { epoch: 'e', sequence: 1 },
    submissions: [
      {
        clientMessageId: messageId,
        fence: 1,
        payloadFingerprint: '',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null
      }
    ],
    items: [
      {
        itemId: 'turn-1',
        body: {
          kind: 'turn',
          turnId: 'turn-1',
          state: 'completed',
          outcome,
          userItemId: agentJournalSubmissionKey(messageId)
        }
      },
      {
        itemId: 'reply-1',
        turnScope: { kind: 'turn', turnItemId: 'turn-1' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Report sent.' }]
        }
      }
    ]
  } as unknown as AgentJournalSnapshot
}

type Chat = {
  snapshot: AgentJournalSnapshot
  working: boolean
  workReads?: number
  operationRow?: unknown
  turnEnded?: () => void
}

function observeAfterRestart(chat: Chat, sentByRun: boolean) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the host reads the observer calls
  setStructuredAgentSessionHost({
    automationRun: async () => chat.snapshot,
    queuedSendAnswer: async () => null,
    currentWork: async () => {
      chat.workReads = (chat.workReads ?? 0) + 1
      return { working: () => chat.working, hasActionablePrompt: () => false }
    },
    subscribeTurnCompletions: (listener: { emit: (event: unknown) => void }) => {
      chat.turnEnded = () =>
        listener.emit({ type: 'completion', completion: { sessionId: 'chat-1' } })
      return () => {}
    },
    observeConversationPublications: (
      _sessionId: string,
      observer: { next: (hint: unknown) => void }
    ) => {
      queueMicrotask(() => observer.next({ kind: 'snapshot', journal: null, source: 'local' }))
      return () => {}
    }
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime calls the observer makes
  const runtime = {
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => ({
      getOperationRow: () => chat.operationRow,
      getConversation: () => ({ provider: 'claude', location: { workspaceId: 'ws-1' } })
    })
  } as unknown as OrcaRuntimeService
  return observeAutomationChatRun(runtime, run, new AbortController().signal, sentByRun)
}

const derivedId = automationRunOperationId(run, 'run-message')

beforeEach(() => {
  // Only the clock: the run's 6-hour deadline counts from NOW.
  vi.useFakeTimers({ now: NOW + 60_000, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  setStructuredAgentSessionHost(null)
})

it('settles a run from its own turn after a restart, by how that turn ended', async () => {
  const finished = await observeAfterRestart(
    { snapshot: chatWith(derivedId, 'success'), working: false },
    true
  )
  expect(finished.status).toBe('completed')
  expect(finished.error).toBeNull()
  expect(finished.outputSnapshot?.content.trim()).toBe('Report sent.')

  const failed = await observeAfterRestart(
    { snapshot: chatWith(derivedId, 'failure'), working: false },
    true
  )
  expect(failed.status).toBe('dispatch_failed')
})

it('finds a room run by the same derived id', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an empty room reads only its messages
  const groups = { store: { roomMessages: () => [] }, runtime: {} } as unknown as BotGroupRuntime
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reservation reads only these fields
  const room = { id: 'room-1', members: [{ botId: 'b1', sessionId: 'chat-1' }] } as BotGroup
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reservation reads only these fields
  const member = { id: 'b1', name: 'Reporter', agent: 'claude' } as Bot
  const { turns } = await reserveGroupTurns(
    groups,
    room,
    undefined,
    [member],
    ['b1'],
    () => derivedId
  )
  expect(turns.map((turn) => turn.operationId)).toEqual([derivedId])

  const settled = await observeAfterRestart(
    { snapshot: chatWith(turns[0].operationId, 'success'), working: false },
    true
  )
  expect(settled.status).toBe('completed')
})

it('waits for a busy chat to go idle before settling a run sent before derived ids', async () => {
  const chat: Chat = { snapshot: chatWith('random-older-id', 'success'), working: true }
  let settled: Awaited<ReturnType<typeof observeAfterRestart>> | undefined
  void observeAfterRestart(chat, true).then((value) => (settled = value))
  await vi.waitFor(() => expect(chat.workReads).toBe(1))
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
  expect(settled).toBeUndefined()

  chat.working = false
  chat.turnEnded?.()
  await vi.waitFor(() => expect(settled).toBeDefined())
  expect(settled?.status).toBe('dispatch_failed')
  expect(settled?.error).toMatch(/restarted before this run's result was recorded/)
})

it('keeps a launched Chat run on its receipt: a failed or expired one stays dispatch_failed', async () => {
  for (const operationRow of [undefined, { outcome: { status: 'failed' } }]) {
    const settled = await observeAfterRestart(
      { snapshot: chatWith(derivedId, 'success'), working: false, operationRow },
      false
    )
    expect(settled.status).toBe('dispatch_failed')
    expect(settled.error).toMatch(/could not confirm this run's prompt/)
  }
})
