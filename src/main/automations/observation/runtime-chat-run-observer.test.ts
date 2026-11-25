import { afterEach, expect, it } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { automationRunOperationId } from '../launch/automation-run-operation'
import { observeAutomationChatRun } from './runtime-chat-run-observer'

// After a restart, a run that sent into a chat it did not launch has no launch receipt: Orca finds
// its turn by the run-derived message id, and a run sent before those ids existed has an unknown end.
const run: AutomationRun = {
  id: 'run-7',
  automationId: 'auto-1',
  title: 'Daily report',
  scheduledFor: 1_000,
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
  startedAt: 1_000,
  dispatchedAt: 1_000,
  createdAt: 1_000
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

function observeAfterRestart(snapshot: AgentJournalSnapshot) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the host reads the observer calls
  setStructuredAgentSessionHost({
    automationRun: async () => snapshot,
    queuedSendAnswer: async () => null,
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
      getOperationRow: () => undefined,
      getConversation: () => ({ provider: 'claude', location: { workspaceId: 'ws-1' } })
    })
  } as unknown as OrcaRuntimeService
  return observeAutomationChatRun(runtime, run, new AbortController().signal)
}

afterEach(() => setStructuredAgentSessionHost(null))

it('settles a run from its own turn after a restart, by how that turn ended', async () => {
  const messageId = automationRunOperationId(run, 'run-message')
  const finished = await observeAfterRestart(chatWith(messageId, 'success'))
  expect(finished.status).toBe('completed')
  expect(finished.error).toBeNull()
  expect(finished.outputSnapshot?.content.trim()).toBe('Report sent.')

  const failed = await observeAfterRestart(chatWith(messageId, 'failure'))
  expect(failed.status).toBe('dispatch_failed')
})

it('settles a run sent before run messages had derived ids as an unknown result, not a failure', async () => {
  const settled = await observeAfterRestart(chatWith('random-older-id', 'success'))
  expect(settled.status).toBe('completed')
  expect(settled.outputSnapshot ?? null).toBeNull()
  expect(settled.error).toMatch(/result is unknown/)
})
