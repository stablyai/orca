import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LinearClientModule from '../linear/client'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const COMMENT_ID = '9f3c2a10-1111-4222-8333-444455556666'

const mocks = vi.hoisted(() => ({
  getClients: vi.fn(),
  getStatus: vi.fn(),
  lookup: vi.fn(),
  updateComment: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn()
}))

vi.mock('../linear/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LinearClientModule>()),
  getClients: mocks.getClients,
  getStatus: mocks.getStatus
}))

vi.mock('../linear/linear-sdk', () => ({
  loadLinearSdk: () => ({
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
  })
}))

import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'
import { acquire, release } from '../linear/linear-request-concurrency'
import { addIssueCommentForAgent } from '../linear/linear-issue-comments'
import { linearError } from '../linear/issue-context/errors'

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
    resolveWorktreeSelector: async () => {
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

  it.each([
    { workspaces: [], workspaceId: undefined, missingToken: false, code: 'linear_not_connected' },
    {
      workspaces: [{ id: 'w2' }],
      workspaceId: 'typo',
      missingToken: false,
      code: 'linear_invalid_workspace'
    },
    {
      workspaces: [{ id: 'w2' }],
      workspaceId: undefined,
      missingToken: true,
      code: 'linear_not_connected'
    },
    {
      workspaces: [{ id: 'w1' }, { id: 'w2' }],
      workspaceId: undefined,
      missingToken: true,
      code: 'linear_not_connected'
    },
    {
      workspaces: [{ id: 'w1' }],
      workspaceId: undefined,
      missingToken: false,
      code: 'linear_comment_not_found'
    }
  ])(
    'distinguishes inspected absence from unavailable access: $code',
    async ({ workspaces, workspaceId, missingToken, code }) => {
      mocks.getStatus.mockReturnValue({ workspaces })
      if (missingToken) {
        const clients = mocks.getClients.getMockImplementation()
        mocks.getClients.mockImplementation((id: string, signal?: AbortSignal) =>
          id === 'w2' ? [] : clients?.(id, signal)
        )
      }
      mocks.lookup.mockResolvedValue({ data: { comment: null } })
      await expect(
        createCommands().linearCommentDelete({ commentId: COMMENT_ID, workspaceId })
      ).rejects.toMatchObject({ code })
      expect(mocks.deleteComment).not.toHaveBeenCalled()
    }
  )

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

  it('keeps add uncertainty while preventing an expired queued add from invoking Linear', async () => {
    vi.useFakeTimers()
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    try {
      const pending = createCommands().runLinearAgentWrite(
        (signal) => addIssueCommentForAgent('issue-1', 'body', 'w2', { id: COMMENT_ID, signal }),
        () => linearError('linear_write_unconfirmed', 'Add was not confirmed.')
      )
      const rejected = expect(pending).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })
      await vi.advanceTimersByTimeAsync(25_000)
      await rejected
      expect(mocks.createComment).not.toHaveBeenCalled()
    } finally {
      for (let i = 0; i < 4; i++) {
        release()
      }
    }
  })

  it('pins uncertainty to the owner only after invoking the provider', async () => {
    vi.useFakeTimers()
    mocks.lookup.mockResolvedValue(rawComment('body'))
    let finish: () => void = () => {}
    mocks.deleteComment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ success: true })
        })
    )
    const pending = createCommands().linearCommentDelete({
      commentId: COMMENT_ID,
      workspaceId: 'w2'
    })
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: { workspaceId: 'w2', issueIdentifier: 'ENG-1' }
    })
    try {
      await vi.advanceTimersByTimeAsync(25_000)
      await rejected
      expect(mocks.deleteComment).toHaveBeenCalledTimes(1)
    } finally {
      finish()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('reports a failed edit readback as unconfirmed in its owning workspace', async () => {
    mocks.lookup.mockImplementation(() => {
      if (mocks.updateComment.mock.calls.length > 0) {
        throw new Error('Network unavailable')
      }
      return rawComment('body')
    })
    mocks.updateComment.mockResolvedValue({ success: true })
    await expect(
      createCommands().linearCommentEdit({
        commentId: COMMENT_ID,
        body: 'edited',
        workspaceId: 'w2'
      })
    ).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: { workspaceId: 'w2', issueIdentifier: 'ENG-1' }
    })
    expect(mocks.updateComment).toHaveBeenCalledTimes(1)
  })

  it('edits a comment in the workspace that owns it and refreshes its worktree', async () => {
    mocks.lookup.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'w1') {
        throw new Error('Entity not found: Comment - Could not find referenced Comment.')
      }
      return rawComment(mocks.updateComment.mock.calls.length > 0 ? 'new body' : 'old body')
    })
    mocks.updateComment.mockResolvedValue({ success: true })
    const emitClientEvent = vi.fn()

    const result = await createCommands(emitClientEvent).linearCommentEdit({
      commentId: COMMENT_ID,
      body: 'new body'
    })

    expect(mocks.updateComment).toHaveBeenCalledWith(COMMENT_ID, { body: 'new body' })
    expect(result).toEqual({
      comment: {
        id: COMMENT_ID,
        url: 'https://linear.app/acme/issue/ENG-1#comment-1',
        parentId: null
      },
      issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' },
      meta: { workspaceId: 'w2', bodyChars: 8 }
    })
    expect(emitClientEvent).toHaveBeenCalledWith({
      type: 'linearLinkedIssueUpdated',
      worktreeId: 'wt-1',
      identifier: 'ENG-1',
      workspaceId: 'w2'
    })
  })

  it('deletes a found comment and refuses an id no workspace knows', async () => {
    mocks.lookup.mockResolvedValue(rawComment('body'))
    mocks.deleteComment.mockResolvedValue({ success: true })

    await expect(
      createCommands().linearCommentDelete({ commentId: COMMENT_ID, workspaceId: 'w2' })
    ).resolves.toMatchObject({ comment: { id: COMMENT_ID }, meta: { workspaceId: 'w2' } })
    expect(mocks.deleteComment).toHaveBeenCalledWith(COMMENT_ID)

    mocks.deleteComment.mockClear()
    mocks.lookup.mockResolvedValue({ data: { comment: null } })
    await expect(
      createCommands().linearCommentDelete({ commentId: COMMENT_ID })
    ).rejects.toMatchObject({ code: 'linear_comment_not_found' })
    expect(mocks.deleteComment).not.toHaveBeenCalled()
  })
})
