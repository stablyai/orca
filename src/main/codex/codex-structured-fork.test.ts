import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'

const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'chosen-turn'
} as const

function connectionFor(
  request: CodexAppServerConnection['request']
): Pick<CodexAppServerConnection, 'request'> {
  return { request }
}

describe('Codex structured fork', () => {
  it('forks inclusively with metadata-only hydration and verifies ancestry', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'child', forkedFromId: 'parent', turns: [] } })
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).resolves.toMatchObject({ threadId: 'child' })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'thread/fork',
      { threadId: 'parent', lastTurnId: 'chosen-turn', excludeTurns: true, cwd: '/workspace' },
      { timeoutMs: 100 }
    )
  })

  it.each([
    { id: 'parent', forkedFromId: 'parent' },
    { id: 'child', forkedFromId: 'foreign' },
    { id: 'child' }
  ])('refuses an unproved fork identity %j', async (thread) => {
    const request = vi.fn().mockResolvedValue({ thread })
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).rejects.toThrow('agent_session_provider_handle_invalid')
  })

  it('caches a narrowly proven excludeTurns refusal on thread/fork and retries without it', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/fork',
          -32602,
          'codex app-server thread/fork failed: unknown field `excludeTurns`'
        )
      }
      return { thread: { id: 'child', forkedFromId: 'parent', turns: [{ id: 'kept', items: [] }] } }
    })
    const connection = connectionFor(request)

    const first = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'parent' },
      100,
      fork
    )
    const second = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'parent' },
      100,
      fork
    )

    expect(first).toMatchObject({ threadId: 'child' })
    expect(second).toMatchObject({ threadId: 'child' })
    // The refusal is cached, so the second fork never re-sends the known-invalid field.
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['thread/fork', expect.objectContaining({ excludeTurns: true })],
      ['thread/fork', { threadId: 'parent', lastTurnId: 'chosen-turn', cwd: '/workspace' }],
      ['thread/fork', { threadId: 'parent', lastTurnId: 'chosen-turn', cwd: '/workspace' }]
    ])
  })

  it('does not retry an ambiguous invalid-params refusal of thread/fork', async () => {
    const invalid = new CodexAppServerRequestError(
      'thread/fork',
      -32602,
      'codex app-server thread/fork failed: invalid params'
    )
    const request = vi.fn(async () => {
      throw invalid
    })
    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'parent' },
        100,
        fork
      )
    ).rejects.toBe(invalid)
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps the excludeTurns capability per method, not per connection', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/fork' && params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/fork',
          -32602,
          'codex app-server thread/fork failed: unknown field `excludeTurns`'
        )
      }
      return method === 'thread/fork'
        ? { thread: { id: 'child', forkedFromId: 'parent', turns: [] } }
        : { thread: { id: 'parent', turns: [] } }
    })
    const connection = connectionFor(request)

    await openCodexThread(connection, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    await openCodexThread(connection, { cwd: '/workspace', resumeThreadId: 'parent' }, 100)

    // A fork refusal must not strip the optimization from a resume that still accepts it.
    expect(request.mock.calls.at(-1)).toEqual([
      'thread/resume',
      { threadId: 'parent', cwd: '/workspace', excludeTurns: true },
      { timeoutMs: 100 }
    ])
  })

  it('does not fall back to unbounded/latest forking when a turn is in progress', async () => {
    const request = vi.fn().mockRejectedValue(new Error('referenced turn is in progress'))
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).rejects.toThrow('in progress')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
