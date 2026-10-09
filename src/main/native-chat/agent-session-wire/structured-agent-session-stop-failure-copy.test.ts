import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-request-error'
import { codexTurnLifecycleRig } from '../../codex/codex-structured-dispatch-test-support'
import {
  acquired,
  fakeCodex,
  identityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

let root: string
const journals = createTrackedJournalOpener()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-copy-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function runningContext(
  cancelTurn: AgentSessionTurnContext['adapter']['cancelTurn'],
  turnId = 'turn-1'
) {
  const journal = await journals.open({ identity: identityFor('session-1'), stateDirectory: root })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-abc', turnId, ordinal: 0 },
    { kind: 'turn', turnId, state: 'running' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const ctx: AgentSessionTurnContext = {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: 7,
    agents: NO_STRUCTURED_AGENTS,
    agent: 'codex',
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn,
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1,
    failureTextContext: { agentName: 'Codex' }
  }
  return ctx
}

describe('Stop wording follows the host verdict', () => {
  it('keeps a failed interrupt distinct from no running turn when child exit is unverifiable', async () => {
    const codex = fakeCodex({
      'turn/interrupt': () => {
        throw new CodexAppServerRequestError(
          'turn/interrupt',
          -32603,
          'interrupt failed',
          'write EPIPE'
        )
      }
    })
    const adapter = await acquired(codex)
    const ctx = await runningContext(adapter.cancelTurn)
    const result = await performCancel(ctx, {
      clientOperationId: 'stop-1',
      stopChild: async () => {
        throw new Error('exit unverifiable')
      },
      childReleased: () => false
    })
    expect(result).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(ctx.journal.activeTurnId()).toBe('turn-1')
    expect(ctx.journal.snapshot().items.map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        text: "Codex didn't stop. Check the chat before trying again.",
        failure: { kind: 'stopRefused', detail: { text: 'write EPIPE', audience: 'log' } }
      })
    )
  })

  it('keeps the requested-turn verdict without claiming the whole agent is idle', async () => {
    const ctx = await runningContext(async () => ({
      cancelled: false,
      refusal: { turnNotRunning: true }
    }))
    await performCancel(ctx, { clientOperationId: 'stop-2' })
    expect(ctx.journal.snapshot().items.map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        text: "Codex didn't stop. Check the chat before trying again.",
        failure: { kind: 'stopRefused', turnNotRunning: true }
      })
    )
  })

  it('does not claim Codex is idle when it refuses a different turn', async () => {
    const rig = await codexTurnLifecycleRig()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    await sending
    const ctx = await runningContext(rig.adapter.cancelTurn, 'turn-journal')

    const result = await performCancel(ctx, { clientOperationId: 'stop-another-turn' })

    expect(result).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(rig.turns.turnId).toBe('turn-1')
    expect(ctx.journal.activeTurnId()).toBe('turn-journal')
    expect(ctx.journal.snapshot().items.map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        text: "Codex didn't stop. Check the chat before trying again.",
        failure: expect.objectContaining({ kind: 'stopRefused', turnNotRunning: true })
      })
    )
  })

  it('names the chat agent when the interrupt throws without a provider refusal', async () => {
    const ctx = await runningContext(async () => {
      throw new Error('request timed out')
    })
    await performCancel(ctx, { clientOperationId: 'stop-3' })
    expect(ctx.journal.snapshot().items.map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        text: "Codex hasn't confirmed that it stopped. Check the chat before trying again."
      })
    )
  })
})
