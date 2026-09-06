import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_MAX_RECORD_BYTES,
  CodexAppServerFrameSizeError,
  CodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'

function connectionFor(
  request: CodexAppServerConnection['request']
): Pick<CodexAppServerConnection, 'request'> {
  return { request }
}

describe('openCodexThread', () => {
  it('requests metadata-only state when resuming an existing thread', async () => {
    const request = vi.fn(async () => ({
      thread: { id: 'thread-1', path: '/history/thread-1.jsonl' },
      model: 'gpt-live'
    }))

    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-1', resumePath: '/history/thread-1.jsonl' },
        2_000
      )
    ).resolves.toMatchObject({ threadId: 'thread-1', model: 'gpt-live' })

    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      {
        threadId: 'thread-1',
        cwd: '/workspace',
        path: '/history/thread-1.jsonl',
        excludeTurns: true
      },
      { timeoutMs: 2_000 }
    )
  })

  it('caches a narrowly proven excludeTurns refusal and uses one bounded fallback', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32602,
          'codex app-server thread/resume failed: unknown field `excludeTurns`'
        )
      }
      return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', items: [] }] } }
    })
    const connection = connectionFor(request)

    const first = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'thread-1' },
      2_000
    )
    const second = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'thread-1' },
      2_000
    )

    expect(first.thread?.turns).toHaveLength(1)
    expect(second.thread?.turns).toHaveLength(1)
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ excludeTurns: true }),
      { threadId: 'thread-1', cwd: '/workspace' },
      { threadId: 'thread-1', cwd: '/workspace' }
    ])
  })

  it('does not retry ambiguous invalid params or oversized history responses', async () => {
    const invalid = new CodexAppServerRequestError(
      'thread/resume',
      -32602,
      'codex app-server thread/resume failed: invalid params'
    )
    const invalidRequest = vi.fn(async () => {
      throw invalid
    })
    await expect(
      openCodexThread(
        connectionFor(invalidRequest),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBe(invalid)
    expect(invalidRequest).toHaveBeenCalledOnce()

    const oversized = new CodexAppServerFrameSizeError('thread/resume', 16_777_217, 16_777_216)
    const oversizedRequest = vi.fn(async () => {
      throw oversized
    })
    await expect(
      openCodexThread(
        connectionFor(oversizedRequest),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBe(oversized)
    expect(oversizedRequest).toHaveBeenCalledOnce()
  })

  it('refuses an oversized fallback result returned by a connection double', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32602,
          'codex app-server thread/resume failed: unsupported excludeTurns parameter'
        )
      }
      return {
        thread: {
          id: 'thread-1',
          turns: [
            { id: 'turn-1', items: [{ output: 'x'.repeat(CODEX_APP_SERVER_MAX_RECORD_BYTES) }] }
          ]
        }
      }
    })

    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBeInstanceOf(CodexAppServerFrameSizeError)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
