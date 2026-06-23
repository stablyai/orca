import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  fetchDeleteIssueComment,
  fetchMergePR,
  fetchResolveReviewThread,
  fetchUpdateIssueComment,
  fetchUpdatePRTitle
} from './github-pr-mutations'

function okResponse(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function errResponse(message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code: 'failed', message }, _meta: { runtimeId: 'r' } }
}

function clientReturning(response: RpcResponse) {
  return { sendRequest: vi.fn(async () => response) }
}

function clientRejecting(message: string) {
  return {
    sendRequest: vi.fn(async () => {
      throw new Error(message)
    })
  }
}

const WORKTREE_ID = 'repo-42::/path/to/wt'

describe('fetchResolveReviewThread / fetchUpdatePRTitle — bare-boolean host result', () => {
  it('treats an explicit true as success', async () => {
    const resolve = await fetchResolveReviewThread(clientReturning(okResponse(true)), WORKTREE_ID, {
      threadId: 't',
      resolve: true
    })
    expect(resolve).toEqual({ ok: true })
    const title = await fetchUpdatePRTitle(clientReturning(okResponse(true)), WORKTREE_ID, {
      prNumber: 1,
      title: 'New'
    })
    expect(title).toEqual({ ok: true })
  })

  it('treats a missing/undefined result as failure (not success)', async () => {
    const resolve = await fetchResolveReviewThread(
      clientReturning(okResponse(undefined)),
      WORKTREE_ID,
      { threadId: 't', resolve: true }
    )
    expect(resolve.ok).toBe(false)
    const title = await fetchUpdatePRTitle(clientReturning(okResponse(undefined)), WORKTREE_ID, {
      prNumber: 1,
      title: 'New'
    })
    expect(title.ok).toBe(false)
  })

  it('treats false as failure', async () => {
    const resolve = await fetchResolveReviewThread(
      clientReturning(okResponse(false)),
      WORKTREE_ID,
      {
        threadId: 't',
        resolve: false
      }
    )
    expect(resolve.ok).toBe(false)
  })
})

describe('mutation transport rejection normalization', () => {
  it('normalizes a thrown sendRequest into { ok:false, error } (envelope mutations)', async () => {
    const out = await fetchMergePR(clientRejecting('socket hung up'), WORKTREE_ID, { prNumber: 1 })
    expect(out).toEqual({ ok: false, error: 'socket hung up' })
  })

  it('normalizes a thrown sendRequest for bare-boolean mutations', async () => {
    const resolve = await fetchResolveReviewThread(
      clientRejecting('connection dropped'),
      WORKTREE_ID,
      {
        threadId: 't',
        resolve: true
      }
    )
    expect(resolve).toEqual({ ok: false, error: 'connection dropped' })
    const title = await fetchUpdatePRTitle(clientRejecting('connection dropped'), WORKTREE_ID, {
      prNumber: 1,
      title: 'New'
    })
    expect(title).toEqual({ ok: false, error: 'connection dropped' })
  })

  it('surfaces a transport error message on a failed response', async () => {
    const out = await fetchMergePR(clientReturning(errResponse('permission denied')), WORKTREE_ID, {
      prNumber: 1
    })
    expect(out).toEqual({ ok: false, error: 'permission denied' })
  })
})

describe('fetchUpdateIssueComment / fetchDeleteIssueComment — slug-addressed envelope', () => {
  it('sends owner/repo/commentId(+body) and reads the { ok } envelope', async () => {
    const editClient = clientReturning(okResponse({ ok: true }))
    const edit = await fetchUpdateIssueComment(editClient, {
      owner: 'o',
      repo: 'r',
      commentId: 5,
      body: 'edited'
    })
    expect(edit).toEqual({ ok: true })
    expect(editClient.sendRequest).toHaveBeenCalledWith('github.project.updateIssueCommentBySlug', {
      owner: 'o',
      repo: 'r',
      commentId: 5,
      body: 'edited'
    })

    const delClient = clientReturning(okResponse({ ok: true }))
    const del = await fetchDeleteIssueComment(delClient, { owner: 'o', repo: 'r', commentId: 5 })
    expect(del).toEqual({ ok: true })
    expect(delClient.sendRequest).toHaveBeenCalledWith('github.project.deleteIssueCommentBySlug', {
      owner: 'o',
      repo: 'r',
      commentId: 5
    })
  })

  it('surfaces a host object error { type, message } as failure', async () => {
    const out = await fetchUpdateIssueComment(
      clientReturning(
        okResponse({ ok: false, error: { type: 'permission', message: 'not authorized' } })
      ),
      { owner: 'o', repo: 'r', commentId: 5, body: 'x' }
    )
    expect(out).toEqual({ ok: false, error: 'not authorized' })
  })

  it('normalizes a transport rejection', async () => {
    const out = await fetchDeleteIssueComment(clientRejecting('offline'), {
      owner: 'o',
      repo: 'r',
      commentId: 5
    })
    expect(out).toEqual({ ok: false, error: 'offline' })
  })
})
