import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { compactCodexSession } from './codex-structured-compact'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import type { CodexSession } from './codex-structured-session-state'

type RunArgs = Parameters<StructuredSessionCompaction['run']>

/** Runs the caller's invoke immediately so the closure under test is observable. */
function makeCompactions(calls: string[] = []): {
  compactions: StructuredSessionCompaction
  runArgs: () => RunArgs
} {
  let seen: RunArgs
  const run = vi.fn(async (...args: RunArgs) => {
    seen = args
    calls.push('run')
    return (await args[2]()) as { error?: string }
  })
  return {
    compactions: { run } as unknown as StructuredSessionCompaction,
    runArgs: () => seen
  }
}

function makeSession(request: ReturnType<typeof vi.fn>): CodexSession {
  return { connection: { request }, threadId: 'thread-1' } as unknown as CodexSession
}

function makeTurnCancellation(calls: string[]): CodexStructuredTurnCancellation {
  return {
    captureBaseline: vi.fn(async () => {
      calls.push('captureBaseline')
    })
  } as unknown as CodexStructuredTurnCancellation
}

const INPUT = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  onLateResult: vi.fn()
} as unknown as Parameters<typeof compactCodexSession>[0]['input']

describe('compacting a Codex session', () => {
  it('starts the compaction on the session thread under the request deadline', async () => {
    const calls: string[] = []
    const { compactions, runArgs } = makeCompactions(calls)
    const request = vi.fn().mockResolvedValue({})

    await compactCodexSession({
      compactions,
      turnCancellation: makeTurnCancellation(calls),
      session: makeSession(request),
      requestTimeoutMs: 7_000,
      input: INPUT
    })

    expect(request).toHaveBeenCalledWith(
      'thread/compact/start',
      { threadId: 'thread-1' },
      { timeoutMs: 7_000 }
    )
    // The bookkeeping is keyed by session but deduped by thread, and it needs the
    // caller's turn id and late-result sink to settle a compaction that outlives us.
    const [sessionId, identity, , onLateResult, turnId] = runArgs()
    expect([sessionId, identity, turnId]).toEqual(['session-1', 'thread-1', 'turn-1'])
    expect(onLateResult).toBe(INPUT.onLateResult)
  })

  it('captures the cancellation baseline before asking the provider', async () => {
    const calls: string[] = []
    const { compactions } = makeCompactions(calls)
    const request = vi.fn(async () => {
      calls.push('request')
      return {}
    })

    await compactCodexSession({
      compactions,
      turnCancellation: makeTurnCancellation(calls),
      session: makeSession(request),
      requestTimeoutMs: undefined,
      input: INPUT
    })

    // A baseline taken after the request would miss the turn the compaction starts.
    expect(calls).toEqual(['run', 'captureBaseline', 'request'])
  })

  it('reports a refusal as a compaction error instead of failing the call', async () => {
    const calls: string[] = []
    const { compactions } = makeCompactions(calls)
    const request = vi
      .fn()
      .mockRejectedValue(
        new CodexAppServerRequestError('thread/compact/start', -32000, 'Nothing to compact.')
      )

    const result = await compactCodexSession({
      compactions,
      turnCancellation: makeTurnCancellation(calls),
      session: makeSession(request),
      requestTimeoutMs: 7_000,
      input: INPUT
    })

    expect(result).toEqual({ error: 'Nothing to compact.' })
  })

  it('rethrows a transport failure rather than reporting it as a refusal', async () => {
    const calls: string[] = []
    const { compactions } = makeCompactions(calls)
    const request = vi.fn().mockRejectedValue(new Error('The provider exited.'))

    // Why: without this the refusal case above passes even if every error maps,
    // which would silently swallow a dead session as an ordinary compaction result.
    await expect(
      compactCodexSession({
        compactions,
        turnCancellation: makeTurnCancellation(calls),
        session: makeSession(request),
        requestTimeoutMs: 7_000,
        input: INPUT
      })
    ).rejects.toThrow('The provider exited.')
  })
})
