import { describe, expect, it, vi } from 'vitest'
import {
  archiveReleasedCodexWorkerThread,
  reconcileCodexWorkerThreadForDispatch,
  retryCodexWorkerThreadLifecycleBacklog,
  type WithCodexWorkerThreadAppServer
} from './codex-worker-thread-lifecycle'
import type { CodexWorkerThreadRequest } from '../../codex/codex-worker-thread-lifecycle'

function resource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wtr-worker',
    owner_dispatch_id: 'ctx-worker',
    terminal_handle: 'term-worker',
    ownership_state: 'owned',
    release_state: 'not_requested',
    codex_thread_id: null,
    codex_auto_name: null,
    codex_name_state: null,
    codex_archive_state: null,
    ...overrides
  }
}

describe('Orca Codex worker thread reconciliation', () => {
  it('persists and names the exact delayed Codex session for one dispatch', async () => {
    let exactSession: ReturnType<typeof buildSession> | null = null
    let current = resource()
    const db = {
      getWorkerTerminalResourceByOwner: vi.fn(() => current),
      getWorkerDispatch: vi.fn(() => ({ created_at: '2026-08-27 00:00:00' })),
      getDispatchContextById: vi.fn(() => ({ task_id: 'task-worker' })),
      getTask: vi.fn(() => ({
        spec: 'Implement exact lifecycle',
        task_title: null,
        display_name: null
      })),
      recordWorkerCodexThreadIdentity: vi.fn((input) => {
        current = resource({
          codex_thread_id: input.threadId,
          codex_auto_name: input.autoName,
          codex_name_state: 'pending',
          codex_archive_state: 'not_requested'
        })
        return current
      }),
      markWorkerCodexThreadNameOutcome: vi.fn((_id, outcome) => {
        current = resource({ ...current, codex_name_state: outcome })
        return current
      }),
      recordWorkerCodexThreadLifecycleError: vi.fn()
    }
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/read') {
        return { thread: { id: params?.threadId, name: null } }
      }
      if (method === 'thread/name/set') {
        return {}
      }
      throw new Error(`unexpected ${method}`)
    })
    const args = {
      db: db as never,
      dispatchId: 'ctx-worker',
      getExactWorkerProviderSession: vi.fn(() => exactSession),
      withCodex: (async <T>(body: (request: CodexWorkerThreadRequest) => Promise<T>) =>
        body(request)) as WithCodexWorkerThreadAppServer
    }

    await expect(reconcileCodexWorkerThreadForDispatch(args)).resolves.toEqual({
      state: 'session_pending'
    })
    expect(request).not.toHaveBeenCalled()

    exactSession = buildSession('thread-worker')
    await expect(reconcileCodexWorkerThreadForDispatch(args)).resolves.toEqual({ state: 'named' })
    expect(db.recordWorkerCodexThreadIdentity).toHaveBeenCalledWith({
      dispatchId: 'ctx-worker',
      resourceId: 'wtr-worker',
      threadId: 'thread-worker',
      autoName: 'Implement exact lifecycle'
    })
    expect(request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'thread-worker',
      name: 'Implement exact lifecycle'
    })
  })

  it('keeps a user rename across duplicate notifications and retries', async () => {
    const current = resource({
      codex_thread_id: 'thread-worker',
      codex_auto_name: 'Automatic name',
      codex_name_state: 'pending',
      codex_archive_state: 'not_requested'
    })
    const db = {
      getWorkerTerminalResourceByOwner: vi.fn(() => current),
      getWorkerDispatch: vi.fn(() => ({ created_at: '2026-08-27 00:00:00' })),
      markWorkerCodexThreadNameOutcome: vi.fn(),
      recordWorkerCodexThreadLifecycleError: vi.fn()
    }
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/read') {
        return { thread: { id: params?.threadId, name: 'User choice' } }
      }
      throw new Error(`unexpected ${method}`)
    })
    const args = {
      db: db as never,
      dispatchId: 'ctx-worker',
      getExactWorkerProviderSession: vi.fn(() => buildSession('thread-worker')),
      withCodex: (async <T>(body: (request: CodexWorkerThreadRequest) => Promise<T>) =>
        body(request)) as WithCodexWorkerThreadAppServer
    }

    await expect(reconcileCodexWorkerThreadForDispatch(args)).resolves.toEqual({
      state: 'user_named'
    })
    expect(db.markWorkerCodexThreadNameOutcome).toHaveBeenCalledWith('wtr-worker', 'user_named')
    expect(request).not.toHaveBeenCalledWith('thread/name/set', expect.anything())
  })

  it('retries a persisted final-release archive after restart idempotently', async () => {
    const pending = resource({
      ownership_state: 'released',
      release_state: 'released',
      codex_thread_id: 'thread-worker',
      codex_auto_name: 'Worker',
      codex_name_state: 'applied',
      codex_archive_state: 'requested'
    })
    const db = {
      getWorkerTerminalResource: vi.fn(() => pending),
      listWorkerCodexThreadLifecycleBacklog: vi.fn(() => [pending]),
      markWorkerCodexThreadArchived: vi.fn(),
      recordWorkerCodexThreadLifecycleError: vi.fn()
    }
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/archive') {
        throw new Error('no rollout found')
      }
      if (method === 'thread/list') {
        return { data: [{ id: params?.archived ? 'thread-worker' : 'other' }], nextCursor: null }
      }
      throw new Error(`unexpected ${method}`)
    })
    const withCodex: WithCodexWorkerThreadAppServer = async <T>(
      body: (request: CodexWorkerThreadRequest) => Promise<T>
    ) => body(request)

    await expect(
      retryCodexWorkerThreadLifecycleBacklog({ db: db as never, withCodex })
    ).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 })
    expect(db.markWorkerCodexThreadArchived).toHaveBeenCalledWith('wtr-worker')
    await expect(
      archiveReleasedCodexWorkerThread({
        db: db as never,
        dispatchId: 'ctx-worker',
        resourceId: 'wtr-worker',
        withCodex
      })
    ).resolves.toEqual({ state: 'already_archived' })
  })
})

function buildSession(threadId: string) {
  return {
    paneKey: 'tab:leaf',
    processIncarnation: 'pty:incarnation',
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: threadId },
    observedAt: Date.now()
  }
}
