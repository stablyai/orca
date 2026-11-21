import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LinearClientModule from '../../../linear/accounts/linear-account-client'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'

const COMMENT_ID = '9f3c2a10-1111-4222-8333-444455556666'

const mocks = vi.hoisted(() => ({
  getClients: vi.fn(),
  getStatus: vi.fn(),
  lookup: vi.fn(),
  updateComment: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn()
}))

vi.mock('../../../linear/accounts/linear-account-client', async (importOriginal) => ({
  ...(await importOriginal<typeof LinearClientModule>()),
  getClients: mocks.getClients,
  getStatus: mocks.getStatus
}))

vi.mock('../../../linear/requests/linear-sdk', () => {
  const sdk = {
    // Why: writes build a fresh SDK client per call so the deadline signal can abort it.
    LinearClient: class {
      client = {
        rawRequest: (_query: string, variables: { id: string }) => mocks.lookup('w2', variables)
      }
      updateComment = mocks.updateComment
      createComment = mocks.createComment
      deleteComment = mocks.deleteComment
    },
    AuthenticationLinearError: class extends Error {}
  }
  return { loadLinearSdk: () => sdk, createLinearClient: () => new sdk.LinearClient() }
})

import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'
import { acquire, release } from '../../../linear/requests/linear-request-concurrency'

function rawComment(body: string): unknown {
  return {
    data: {
      comment: {
        id: COMMENT_ID,
        url: 'https://linear.app/acme/issue/ENG-1#comment-1',
        body,
        parent: null,
        issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' }
      }
    }
  }
}

function createCommands(emitClientEvent = vi.fn()): RuntimeLinearReadCommands {
  const worktree: ResolvedWorktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/pr-30003/worktree',
    head: 'head',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: 'ENG-1',
    linkedLinearIssueWorkspaceId: 'w2',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path: '/tmp/pr-30003/worktree',
      head: 'head',
      branch: 'main',
      isBare: false,
      isMainWorktree: false
    }
  }
  return new RuntimeLinearReadCommands({
    runtimeAvailable: () => true,
    showTerminal: async () => {
      throw new Error('unused')
    },
    resolveWorkspaceSelector: async () => {
      throw new Error('unused')
    },
    listResolvedWorktrees: async () => [worktree],
    setWorktreeMeta: () => {},
    emitClientEvent
  })
}

describe('Linear comment edit and delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStatus.mockReturnValue({ workspaces: [{ id: 'w1' }, { id: 'w2' }] })
    mocks.getClients.mockImplementation((workspaceId: string, signal?: AbortSignal) => [
      {
        workspace: { id: workspaceId },
        apiKey: `key-${workspaceId}`,
        client: {
          client: {
            rawRequest: (_query: string, variables: { id: string }) =>
              mocks.lookup(workspaceId, variables, signal)
          }
        }
      }
    ])
  })
  afterEach(() => vi.useRealTimers())

  it.each(['stalled', 'failed'])(
    'uses the first owner despite a %s unrelated lookup',
    async (state) => {
      let losingSignal: AbortSignal | undefined
      let finish: () => void = () => {}
      mocks.lookup.mockImplementation((id: string, _variables: unknown, signal?: AbortSignal) => {
        if (id === 'w2') {
          return rawComment('body')
        }
        if (state === 'failed') {
          throw new Error('Network unavailable')
        }
        losingSignal = signal
        return new Promise((resolve) => {
          finish = () => resolve({ data: { comment: null } })
        })
      })
      mocks.deleteComment.mockResolvedValue({ success: true })
      try {
        await expect(
          createCommands().linearCommentDelete({ commentId: COMMENT_ID })
        ).resolves.toMatchObject({ meta: { workspaceId: 'w2' } })
        if (state === 'stalled') {
          expect(losingSignal?.aborted).toBe(true)
        }
        expect(mocks.deleteComment).toHaveBeenCalledTimes(1)
      } finally {
        finish()
      }
    }
  )

  it.each(['disconnect', 'discovery deadline', 'queued write deadline', 'absolute deadline'])(
    'never starts a later mutation after %s',
    async (phase) => {
      vi.useFakeTimers()
      const cancellation = new AbortController()
      const clients = mocks.getClients.getMockImplementation()
      let held = 0
      mocks.getClients.mockImplementation((id: string, signal?: AbortSignal) => {
        if (!signal && (phase === 'queued write deadline' || phase === 'absolute deadline')) {
          for (let i = 0; i < 4; i++) {
            void acquire()
            held++
          }
        }
        return clients?.(id, signal)
      })
      let finish: () => void = () => {}
      mocks.lookup.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(rawComment('body'))
          })
      )
      const pending = createCommands().linearCommentDelete(
        { commentId: COMMENT_ID, workspaceId: 'w2' },
        cancellation.signal
      )
      const rejected = expect(pending).rejects.toMatchObject({ code: 'linear_timeout' })
      try {
        await vi.advanceTimersByTimeAsync(0)
        if (phase === 'disconnect') {
          cancellation.abort()
        } else if (phase === 'discovery deadline') {
          await vi.advanceTimersByTimeAsync(30_000)
        } else {
          finish()
          if (phase === 'absolute deadline') {
            await vi.advanceTimersByTimeAsync(0)
            vi.setSystemTime(Date.now() + 55_000)
            for (; held > 0; held--) {
              release()
            }
          }
          await vi.advanceTimersByTimeAsync(phase === 'queued write deadline' ? 25_000 : 0)
        }
        await rejected
        finish()
        for (; held > 0; held--) {
          release()
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.deleteComment).not.toHaveBeenCalled()
        await Promise.all([acquire(), acquire(), acquire(), acquire()])
        for (let i = 0; i < 4; i++) {
          release()
        }
      } finally {
        finish()
        for (; held > 0; held--) {
          release()
        }
      }
    }
  )
})
