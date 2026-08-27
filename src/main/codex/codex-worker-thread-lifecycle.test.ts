import { describe, expect, it, vi } from 'vitest'
import {
  applyCodexWorkerThreadName,
  archiveCodexWorkerThread,
  buildCodexWorkerThreadName
} from './codex-worker-thread-lifecycle'

const DISPATCH_PREAMBLE =
  'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.'

describe('Codex worker thread lifecycle', () => {
  it('derives a concise deterministic worker name instead of exposing the dispatch preamble', () => {
    const name = buildCodexWorkerThreadName({
      spec: `\n\nImplement exact-thread worker lifecycle cleanup\n${DISPATCH_PREAMBLE}`,
      taskTitle: null,
      displayName: null
    })

    expect(name).toBe('Implement exact-thread worker lifecycle cleanup')
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).not.toContain(DISPATCH_PREAMBLE)
  })

  it('names exact worker threads independently during concurrent starts', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = []
    const names = new Map<string, string | null>([
      ['thread-a', null],
      ['thread-b', null]
    ])
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      const threadId = String(params?.threadId)
      if (method === 'thread/read') {
        return { thread: { id: threadId, name: names.get(threadId) } }
      }
      if (method === 'thread/name/set') {
        names.set(threadId, String(params?.name))
        return {}
      }
      throw new Error(`unexpected method ${method}`)
    })

    await Promise.all([
      applyCodexWorkerThreadName({ threadId: 'thread-a', desiredName: 'Worker A', request }),
      applyCodexWorkerThreadName({ threadId: 'thread-b', desiredName: 'Worker B', request })
    ])

    expect(names).toEqual(
      new Map([
        ['thread-a', 'Worker A'],
        ['thread-b', 'Worker B']
      ])
    )
    expect(calls.filter((call) => call.method === 'thread/name/set')).toEqual(
      expect.arrayContaining([
        { method: 'thread/name/set', params: { threadId: 'thread-a', name: 'Worker A' } },
        { method: 'thread/name/set', params: { threadId: 'thread-b', name: 'Worker B' } }
      ])
    )
  })

  it('preserves an explicit user rename', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/read') {
        return { thread: { id: params?.threadId, name: 'My explicit name' } }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      applyCodexWorkerThreadName({
        threadId: 'thread-worker',
        desiredName: 'Automatic worker name',
        request
      })
    ).resolves.toEqual({ state: 'user_named', observedName: 'My explicit name' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('archives only the exact worker thread and never its coordinator', async () => {
    const archived = new Set<string>()
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/archive') {
        archived.add(String(params?.threadId))
        return {}
      }
      if (method === 'thread/list') {
        return { data: [...archived].map((id) => ({ id })), nextCursor: null }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(archiveCodexWorkerThread({ threadId: 'thread-worker', request })).resolves.toEqual(
      { state: 'archived' }
    )
    expect(archived).toEqual(new Set(['thread-worker']))
    expect(archived.has('thread-coordinator')).toBe(false)
  })

  it('treats a retry after restart as archived when Codex already archived the exact thread', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/archive') {
        throw new Error('no rollout found for thread')
      }
      if (method === 'thread/list') {
        return {
          data: [{ id: params?.archived ? 'thread-worker' : 'thread-coordinator' }],
          nextCursor: null
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(archiveCodexWorkerThread({ threadId: 'thread-worker', request })).resolves.toEqual(
      { state: 'already_archived' }
    )
    expect(request).toHaveBeenCalledWith('thread/list', {
      archived: true,
      limit: 100,
      sortKey: 'updated_at'
    })
  })
})
