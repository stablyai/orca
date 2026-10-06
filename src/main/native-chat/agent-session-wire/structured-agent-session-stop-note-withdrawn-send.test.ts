// A Stop that ends the child after its interrupt failed: its row reports on the run it stopped, so
// one whose child end took back the send it found, with no turn running, leaves none. Its message
// is back in the composer, and a row would sit under the turn before as if that turn were stopped.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function stopEndingTheChild(options: {
  turnRunning: boolean
  takesSendBack: boolean
  earlierProcessSendInDoubt?: boolean
}) {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-note-withdrawn-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  if (options.turnRunning) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  if (options.earlierProcessSendInDoubt) {
    await journal.appendSubmission({
      clientMessageId: 'send-0',
      payloadFingerprint: 'send-0',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'before the crash' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-0',
      state: 'unknown',
      reason: 'host_restarted',
      fence: 1,
      recovered: true
    })
  }
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look around' }] },
    fence: 1
  })
  const ctx: AgentSessionTurnContext = {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: 1,
    agents: NO_STRUCTURED_AGENTS,
    agent: 'codex',
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      closeSession: vi.fn(),
      cancelTurn: vi.fn(async () => ({
        cancelled: false,
        refusal: { detail: { text: 'failed to interrupt turn', audience: 'person' as const } }
      })),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
  const result = await performCancel(ctx, {
    clientOperationId: 'stop-1',
    stopChild: async () => {
      if (options.takesSendBack) {
        await journal.resolveDispatch({
          clientMessageId: 'send-1',
          state: 'rejected',
          ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
            surface: 'rejection'
          }),
          fence: 1,
          recovered: true
        })
      }
    }
  })
  const rows = journal
    .snapshot()
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
  return { cancelled: result.ok && result.value.cancelled, rows }
}

describe('a Stop that ends the child after its interrupt failed', () => {
  it('leaves no row when the child end took back the send, with no turn running', async () => {
    expect(await stopEndingTheChild({ turnRunning: false, takesSendBack: true })).toEqual({
      cancelled: true,
      rows: []
    })
  })

  it('says cancellation was requested when the send stays in doubt', async () => {
    expect(await stopEndingTheChild({ turnRunning: false, takesSendBack: false })).toEqual({
      cancelled: true,
      rows: ['Cancellation requested.']
    })
  })

  // That send was never this child's to take back, so it does not keep the row.
  it("leaves no row when the only other send in doubt was an earlier process's", async () => {
    expect(
      await stopEndingTheChild({
        turnRunning: false,
        takesSendBack: true,
        earlierProcessSendInDoubt: true
      })
    ).toEqual({ cancelled: true, rows: [] })
  })

  it('says cancellation was requested on the turn it stopped, whatever became of the send', async () => {
    expect(await stopEndingTheChild({ turnRunning: true, takesSendBack: true })).toEqual({
      cancelled: true,
      rows: ['Cancellation requested.']
    })
  })
})
