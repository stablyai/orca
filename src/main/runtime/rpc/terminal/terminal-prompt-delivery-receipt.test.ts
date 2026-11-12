import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { createAgentPromptSubmissionRuntime } from '../../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-receipt',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    listWorktreesStrict: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-receipt',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

function request(
  terminal: string,
  promptRequestId: string,
  text: string,
  waitSubmitMs?: number
): RpcRequest {
  return {
    id: `rpc-${promptRequestId}`,
    authToken: 'token',
    method: 'terminal.send',
    orchestrationRequestId: promptRequestId,
    params: {
      terminal,
      text,
      enter: true,
      agentPrompt: true,
      waitSubmitMs,
      client: { id: 'orca-cli', type: 'desktop' }
    }
  }
}

async function createHarness(agent: TuiAgent, busy = false) {
  const created = await createAgentPromptSubmissionRuntime(() => undefined, agent)
  created.runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
    write: (_ptyId, data) => {
      created.writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => agent
  })
  const db = new OrchestrationDb(':memory:')
  created.runtime.setOrchestrationDb(db)
  if (busy) {
    created.runtime.onPtyData(
      'pty-prompt',
      `\x1b]9999;{"state":"working","agentType":"${agent}"}\x07`,
      Date.now()
    )
  }
  return {
    ...created,
    db,
    dispatcher: new RpcDispatcher({ runtime: created.runtime, methods: TERMINAL_METHODS })
  }
}

describe('durable terminal prompt delivery receipts', () => {
  afterEach(() => vi.useRealTimers())

  it('replays after a dispatcher replacement without duplicate text or Enter', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const firstPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'crash-retry', 'preserve once')
    )
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const writesAfterFirst = [...harness.writes]
    const replacement = new RpcDispatcher({ runtime: harness.runtime, methods: TERMINAL_METHODS })
    const replay = await replacement.dispatch(
      request(harness.handle, 'crash-retry', 'preserve once')
    )

    expect(first).toMatchObject({ ok: true, result: { mutation: { replayed: false } } })
    expect(replay).toMatchObject({ ok: true, result: { mutation: { replayed: true } } })
    expect(harness.writes).toEqual(writesAfterFirst)
    harness.db.close()
  })

  it('keeps an ambiguous partial write pending and refuses to resend it', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('aider')
    harness.runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
      write: (_ptyId, data) => {
        harness.writes.push(data)
        return data !== '\r'
      },
      kill: () => true,
      getForegroundProcess: async () => 'aider'
    })
    const firstPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'partial-retry', 'partial once')
    )
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const writesAfterFailure = [...harness.writes]
    const retry = await harness.dispatcher.dispatch(
      request(harness.handle, 'partial-retry', 'partial once')
    )

    expect(first).toMatchObject({ ok: false })
    expect(retry).toMatchObject({ ok: false, error: { code: 'operation_unknown' } })
    expect(harness.writes).toEqual(writesAfterFailure)
    harness.db.close()
  })

  it('waits on a replay only for observation and never resends', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const firstPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'observe-retry', 'observe once')
    )
    await vi.runAllTimersAsync()
    await firstPromise
    const writesAfterFirst = [...harness.writes]
    harness.runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"codex"}\x07' +
        '\x1b]9999;{"state":"working","agentType":"codex"}\x07',
      Date.now()
    )

    const observed = await harness.dispatcher.dispatch(
      request(harness.handle, 'observe-retry', 'observe once', 1_000)
    )

    expect(observed).toMatchObject({
      ok: true,
      result: {
        send: {
          prompt: {
            stages: ['input_accepted', 'turn_started']
          }
        },
        mutation: { replayed: true }
      }
    })
    expect(harness.writes).toEqual(writesAfterFirst)
    harness.db.close()
  })

  it('does not let a later queued request claim an earlier lifecycle transition', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const firstPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'ordered-first', 'first prompt')
    )
    await vi.runAllTimersAsync()
    await firstPromise
    const secondPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'ordered-second', 'second prompt')
    )
    await vi.runAllTimersAsync()
    await secondPromise

    harness.runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"codex"}\x07' +
        '\x1b]9999;{"state":"working","agentType":"codex"}\x07',
      Date.now()
    )

    const secondObserved = harness.dispatcher.dispatch(
      request(harness.handle, 'ordered-second', 'second prompt', 1_000)
    )
    await vi.runAllTimersAsync()
    const firstObserved = harness.dispatcher.dispatch(
      request(harness.handle, 'ordered-first', 'first prompt', 1_000)
    )
    await vi.runAllTimersAsync()

    await expect(secondObserved).resolves.toMatchObject({
      ok: true,
      result: { send: { prompt: { stages: ['input_accepted'] } } }
    })
    await expect(firstObserved).resolves.toMatchObject({
      ok: true,
      result: {
        send: { prompt: { stages: ['input_accepted', 'turn_started'] } }
      }
    })
    harness.db.close()
  })

  it('rejects changed payload and replays queued truth after generation replacement', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const firstPromise = harness.dispatcher.dispatch(
      request(harness.handle, 'bound-request', 'original')
    )
    await vi.runAllTimersAsync()
    await firstPromise

    const changedPayload = await harness.dispatcher.dispatch(
      request(harness.handle, 'bound-request', 'changed')
    )
    harness.runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      harness.runtime.getPtyOutputSequence('pty-prompt')
    )
    const changedGeneration = await harness.dispatcher.dispatch(
      request(harness.handle, 'bound-request', 'original', 1_000)
    )

    expect(changedPayload).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(changedGeneration).toMatchObject({
      ok: true,
      result: {
        send: {
          prompt: {
            stages: ['input_accepted'],
            observation: 'incarnation_replaced'
          }
        },
        mutation: { replayed: true }
      }
    })
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    harness.db.close()
  })

  it('does not clear a pre-existing provider draft before appending the prompt', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    harness.runtime.onPtyData('pty-prompt', '› existing human draft', Date.now())
    const responsePromise = harness.dispatcher.dispatch(
      request(harness.handle, 'draft-safe', 'appended prompt')
    )
    await vi.runAllTimersAsync()
    await responsePromise

    expect(harness.writes.join('')).toContain('appended prompt')
    expect(harness.writes.join('')).not.toContain('\u0015')
    harness.db.close()
  })
})
