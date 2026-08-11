import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GIT_METHODS } from './git'
import { ALL_RPC_METHODS } from './index'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const STASH_METHODS = [
  'git.stashList',
  'git.stashPush',
  'git.stashApply',
  'git.stashPop',
  'git.stashDrop',
  'git.stashClear'
] as const

function makeRuntime(overrides: Record<string, unknown>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    listRuntimeGitStashes: vi.fn().mockResolvedValue([]),
    pushRuntimeGitStash: vi.fn().mockResolvedValue({ success: true, stashed: true }),
    applyRuntimeGitStash: vi.fn().mockResolvedValue({ success: true }),
    popRuntimeGitStash: vi.fn().mockResolvedValue({ success: true }),
    dropRuntimeGitStash: vi.fn().mockResolvedValue(undefined),
    clearRuntimeGitStashes: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as OrcaRuntimeService
}

function dispatcherFor(runtime: OrcaRuntimeService): RpcDispatcher {
  return new RpcDispatcher({ runtime, methods: GIT_METHODS })
}

describe('git stash RPC methods', () => {
  it('registers every stash method in the runtime method table', () => {
    // Why: an unregistered method is rejected before dispatch, so the git table
    // and the aggregate registry have to agree.
    const registered = new Set(ALL_RPC_METHODS.map((entry) => entry.name))
    for (const method of STASH_METHODS) {
      expect(GIT_METHODS.some((entry) => entry.name === method)).toBe(true)
      expect(registered.has(method)).toBe(true)
    }
  })

  it('wraps the stash list in an entries envelope', async () => {
    const entry = {
      ref: 'stash@{0}',
      index: 0,
      commitOid: 'b6ca323068fc18c2133f1cc3eb3c2a95e127de7d',
      createdAtSeconds: 1785416506,
      subject: 'WIP on main: init'
    }
    const runtime = makeRuntime({ listRuntimeGitStashes: vi.fn().mockResolvedValue([entry]) })

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashList', { worktree: 'id:wt-1' })
    )

    expect(runtime.listRuntimeGitStashes).toHaveBeenCalledWith('id:wt-1')
    expect(response).toMatchObject({ ok: true, result: { entries: [entry] } })
  })

  it('defaults includeUntracked to false and omits an absent message', async () => {
    const runtime = makeRuntime({})

    await dispatcherFor(runtime).dispatch(makeRequest('git.stashPush', { worktree: 'id:wt-1' }))

    expect(runtime.pushRuntimeGitStash).toHaveBeenCalledWith('id:wt-1', {
      includeUntracked: false
    })
  })

  it('forwards includeUntracked and a message', async () => {
    const runtime = makeRuntime({})

    await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashPush', {
        worktree: 'id:wt-1',
        includeUntracked: true,
        message: 'parked work'
      })
    )

    expect(runtime.pushRuntimeGitStash).toHaveBeenCalledWith('id:wt-1', {
      includeUntracked: true,
      message: 'parked work'
    })
  })

  it('rejects an over-long stash message at the schema', async () => {
    const runtime = makeRuntime({})

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashPush', { worktree: 'id:wt-1', message: 'x'.repeat(501) })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.pushRuntimeGitStash).not.toHaveBeenCalled()
  })

  it.each([
    ['git.stashApply', 'applyRuntimeGitStash'],
    ['git.stashPop', 'popRuntimeGitStash']
  ])('%s targets the newest entry when no ref is given', async (method, runtimeMethod) => {
    const runtime = makeRuntime({})

    await dispatcherFor(runtime).dispatch(makeRequest(method, { worktree: 'id:wt-1' }))

    expect(runtime[runtimeMethod as keyof OrcaRuntimeService]).toHaveBeenCalledWith(
      'id:wt-1',
      null,
      undefined
    )
  })

  it('forwards an explicit ref and expected oid', async () => {
    const runtime = makeRuntime({})
    const oid = 'b6ca323068fc18c2133f1cc3eb3c2a95e127de7d'

    await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashPop', {
        worktree: 'id:wt-1',
        ref: 'stash@{2}',
        expectedCommitOid: oid
      })
    )

    expect(runtime.popRuntimeGitStash).toHaveBeenCalledWith('id:wt-1', 'stash@{2}', oid)
  })

  it.each(['--all', '-p', 'HEAD', 'refs/stash', 'stash@{}', 'stash@{-1}'])(
    'rejects the ref %j before it reaches the runtime',
    async (ref) => {
      const runtime = makeRuntime({})

      const response = await dispatcherFor(runtime).dispatch(
        makeRequest('git.stashDrop', { worktree: 'id:wt-1', ref })
      )

      expect(response).toMatchObject({ ok: false })
      expect(runtime.dropRuntimeGitStash).not.toHaveBeenCalled()
    }
  )

  it('requires a ref for drop', async () => {
    const runtime = makeRuntime({})

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashDrop', { worktree: 'id:wt-1' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.dropRuntimeGitStash).not.toHaveBeenCalled()
  })

  it('rejects a malformed expected oid', async () => {
    const runtime = makeRuntime({})

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashDrop', {
        worktree: 'id:wt-1',
        ref: 'stash@{0}',
        expectedCommitOid: 'abc'
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.dropRuntimeGitStash).not.toHaveBeenCalled()
  })

  it.each([
    ['git.stashDrop', { ref: 'stash@{0}' }],
    ['git.stashClear', {}]
  ])('%s acknowledges with ok', async (method, extra) => {
    const runtime = makeRuntime({})

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest(method, { worktree: 'id:wt-1', ...extra })
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('surfaces a conflicted pop result to the client', async () => {
    const runtime = makeRuntime({
      popRuntimeGitStash: vi
        .fn()
        .mockResolvedValue({ success: false, conflicted: true, error: 'CONFLICT (content)' })
    })

    const response = await dispatcherFor(runtime).dispatch(
      makeRequest('git.stashPop', { worktree: 'id:wt-1' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { success: false, conflicted: true }
    })
  })

  it('rejects a missing worktree selector', async () => {
    const runtime = makeRuntime({})

    const response = await dispatcherFor(runtime).dispatch(makeRequest('git.stashList', {}))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.listRuntimeGitStashes).not.toHaveBeenCalled()
  })
})
