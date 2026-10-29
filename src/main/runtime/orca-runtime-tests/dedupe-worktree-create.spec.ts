import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { partialRuntimeStore, storeRepo, storeWorktreeMeta } from '../runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { runWithActiveRpcCaller } from '../rpc/rpc-active-caller'
import { store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService.dedupeWorktreeCreate', () => {
  it('does not replay a paired caller creation to another with the same retry key', async () => {
    const runtime = new OrcaRuntimeService(store)
    const create = vi.fn(async () => ({ worktree: { id: `wt-${create.mock.calls.length}` } }))
    const alice = await runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, () =>
      runtime.dedupeWorktreeCreate('id:r', 'same-key', create)
    )
    const bob = await runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'bob' }, () =>
      runtime.dedupeWorktreeCreate('id:r', 'same-key', create)
    )
    const aliceRetry = await runWithActiveRpcCaller(
      { kind: 'paired-device', deviceId: 'alice' },
      () => runtime.dedupeWorktreeCreate('id:r', 'same-key', create)
    )
    expect(create).toHaveBeenCalledTimes(2)
    expect(bob).not.toEqual(alice)
    expect(aliceRetry).toEqual(alice)
  })

  it('coalesces concurrent creates that share a clientMutationId', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: 'wt' } })
    }
    const [a, b] = await Promise.all([
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory),
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('reuses a settled success for a retry whose response was lost in a cutover', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: `wt-${calls}` } })
    }
    const first = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    const retried = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    expect(calls).toBe(1)
    expect(retried).toEqual(first)
  })

  it('expires settled successes after the reconnect window', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      let calls = 0
      const factory = (): Promise<{ n: number }> => Promise.resolve({ n: (calls += 1) })
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      await vi.advanceTimersByTimeAsync(59_999)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a failed create so a genuine retry starts fresh', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<never> => {
      calls += 1
      return Promise.reject(new Error(`boom-${calls}`))
    }
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-1')
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-2')
    expect(calls).toBe(2)
  })

  it('never dedupes across repos or when no clientMutationId is supplied', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ n: number }> => {
      calls += 1
      return Promise.resolve({ n: calls })
    }
    await runtime.dedupeWorktreeCreate('id:a', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:b', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    expect(calls).toBe(4)
  })
})

describe('managed workspace GitHub ownership', () => {
  it('captures the authenticated account before creation and persists it before startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-workspace-github-owner-'))
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    const repo = storeRepo({ id: 'folder', path: '/folder', kind: 'folder' })
    const metadata = new Map<string, WorktreeMeta>()
    const runtimeStore = partialRuntimeStore({
      getProfileStorageDirectory: () => directory,
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => Object.fromEntries(metadata),
      getWorktreeMeta: (id) => metadata.get(id),
      setWorktreeMeta: (target, update) => {
        const meta = storeWorktreeMeta(update)
        metadata.set(target.id, meta)
        return meta
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.configureGitHubParticipantDevices(
      () => ({}),
      () => []
    )
    const registry = runtime.getGitHubParticipantRegistry()
    if (!registry) {
      throw new Error('missing test registry')
    }
    const account = { host: 'github.com', user: 'Alice' }
    const alice = registry.createParticipant({
      name: 'Alice',
      deviceIds: ['alice'],
      allowedAccounts: [account]
    })
    registry.setRepoEnabled(repo.id, true)
    registry.selectAccount(repo.id, 'alice', account)
    const result = await runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, () =>
      runtime.createManagedWorktree({ repoSelector: repo.id, name: 'task', runHooks: false })
    )
    expect(metadata.get(result.worktree.id)?.githubExecutionIdentity).toEqual({
      repoId: repo.id,
      participantId: alice.id,
      account
    })
    expect(result.worktree).not.toHaveProperty('githubExecutionIdentity')
    const previousCount = metadata.size
    await expect(
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        runtime.createManagedWorktree({ repoSelector: repo.id, name: 'unauthenticated' })
      )
    ).rejects.toThrow('github_participant_identity_required')
    expect(metadata.size).toBe(previousCount)
  })
})
