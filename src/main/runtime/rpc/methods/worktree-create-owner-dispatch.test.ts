import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { closeTestStores, createStore, testState } from '../../../persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-dispatch-owner-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function repo(suffix: 'a' | 'b'): Repo {
  return {
    id: 'shared-id',
    displayName: 'Shared',
    path: `/receiver/${suffix}`,
    executionHostId: `ssh:private-${suffix}`,
    kind: 'folder',
    badgeColor: '#737373',
    addedAt: 1
  }
}

function fixture(bFirst = false, contradictory = false) {
  const store = createStore()
  for (const suffix of bFirst ? (['b', 'a'] as const) : (['a', 'b'] as const)) {
    store.addRepo({
      ...repo(suffix),
      ...(contradictory && suffix === 'a' ? { connectionId: 'different-host' } : {})
    })
  }
  const runtime = new OrcaRuntimeService(store)
  const create = vi.spyOn(runtime, 'createManagedWorktree')
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  return { store, runtime, create, dispatcher }
}

describe('worktree create dispatcher owner resolution', () => {
  describe.each(['sequential', 'concurrent'])('%s mutation retries', (mode) => {
    it.each([false, true])(
      'keeps distinct qualified owners separate (B first: %s)',
      async (bFirst) => {
        const { store, create, dispatcher } = fixture(bFirst)
        const dispatch = (suffix: 'a' | 'b') =>
          dispatcher.dispatch({
            id: suffix,
            authToken: 'test',
            method: 'worktree.create',
            params: {
              repo: 'shared-id',
              executionHostId: `ssh:private-${suffix}`,
              name: 'selected',
              clientMutationId: 'same-mutation'
            }
          })
        const suffixes = bFirst ? (['b', 'a'] as const) : (['a', 'b'] as const)
        const results =
          mode === 'concurrent'
            ? await Promise.all(suffixes.map(dispatch))
            : [await dispatch(suffixes[0]), await dispatch(suffixes[1])]
        for (const [index, suffix] of suffixes.entries()) {
          expect(results[index]).toMatchObject({
            ok: true,
            result: { worktree: { path: `/receiver/${suffix}`, hostId: `ssh:private-${suffix}` } }
          })
        }
        expect(create).toHaveBeenCalledTimes(2)
        expect(
          Object.values(store.getAllWorktreeMeta())
            .map((meta) => meta.hostId)
            .sort()
        ).toEqual(['ssh:private-a', 'ssh:private-b'])
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: true })
        expect(createStore().getAllWorktreeMeta()).toEqual(store.getAllWorktreeMeta())
      }
    )

    it.each([false, true])(
      'coalesces qualified same-owner retries (B first: %s)',
      async (bFirst) => {
        const { store, create, dispatcher } = fixture(bFirst)
        const dispatch = () =>
          dispatcher.dispatch({
            id: 'retry',
            authToken: 'test',
            method: 'worktree.create',
            params: {
              repo: 'shared-id',
              executionHostId: 'ssh:private-b',
              name: 'selected',
              clientMutationId: 'same-mutation'
            }
          })
        const results =
          mode === 'concurrent'
            ? await Promise.all([dispatch(), dispatch()])
            : [await dispatch(), await dispatch()]
        expect(results[0]).toMatchObject({
          ok: true,
          result: { worktree: { path: '/receiver/b', hostId: 'ssh:private-b' } }
        })
        expect(results[1]).toEqual(results[0])
        expect(create).toHaveBeenCalledOnce()
        expect(Object.values(store.getAllWorktreeMeta())).toHaveLength(1)
      }
    )
  })

  it.each(['shared-id', 'id:shared-id', 'name:Shared', 'path:/receiver/b'])(
    'qualifies the preliminary %s lookup before creation',
    async (selector) => {
      const { store, create, dispatcher } = fixture()
      const before = structuredClone(store.getRepos())
      const result = await dispatcher.dispatch({
        id: 'create',
        authToken: 'test',
        method: 'worktree.create',
        params: { repo: selector, executionHostId: 'ssh:private-b', name: 'selected' }
      })
      expect(result).toMatchObject({
        ok: true,
        result: { worktree: { path: '/receiver/b', hostId: 'ssh:private-b' } }
      })
      expect(create).toHaveBeenCalledOnce()
      expect(Object.values(store.getAllWorktreeMeta())).toEqual([
        expect.objectContaining({ hostId: 'ssh:private-b', displayName: 'selected' })
      ])
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: true })
      const persisted = createStore()
      expect(persisted.getAllWorktreeMeta()).toEqual(store.getAllWorktreeMeta())
      expect(persisted.getRepos()).toEqual(before)
      expect(store.getRepos()).toEqual(before)
    }
  )

  it.each([false, true])(
    'still refuses an unqualified ambiguous selector (B first: %s)',
    async (bFirst) => {
      const { store, create, dispatcher } = fixture(bFirst)
      const result = await dispatcher.dispatch({
        id: 'create',
        authToken: 'test',
        method: 'worktree.create',
        params: { repo: 'shared-id', name: 'selected' }
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'selector_ambiguous' } })
      expect(create).not.toHaveBeenCalled()
      expect(store.getAllWorktreeMeta()).toEqual({})
    }
  )

  it.each([
    { selector: 'shared-id', host: 'ssh:missing', contradictory: false, code: 'repo_not_found' },
    {
      selector: 'path:/receiver/a',
      host: 'ssh:private-b',
      contradictory: false,
      code: 'repo_not_found'
    },
    { selector: 'shared-id', host: 'invalid', contradictory: false, code: 'invalid_argument' },
    { selector: 'shared-id', host: 'ssh:private-b', contradictory: true, code: 'repo_not_found' }
  ])(
    'refuses $host/$selector before creation (contradictory: $contradictory)',
    async ({ selector, host, contradictory, code }) => {
      const { store, create, dispatcher } = fixture(false, contradictory)
      const before = structuredClone(store.getRepos())
      const result = await dispatcher.dispatch({
        id: 'create',
        authToken: 'test',
        method: 'worktree.create',
        params: { repo: selector, executionHostId: host, name: 'selected' }
      })
      expect(result).toMatchObject({ ok: false, error: { code } })
      expect(create).not.toHaveBeenCalled()
      expect(store.getAllWorktreeMeta()).toEqual({})
      expect(store.getRepos()).toEqual(before)
    }
  )

  it('keeps a unique legacy unqualified create working', async () => {
    const store = createStore()
    store.addRepo({ ...repo('b'), executionHostId: 'local' })
    const runtime = new OrcaRuntimeService(store)
    const result = await new RpcDispatcher({ runtime, methods: WORKTREE_METHODS }).dispatch({
      id: 'create',
      authToken: 'test',
      method: 'worktree.create',
      params: { repo: 'shared-id', name: 'legacy' }
    })
    expect(result).toMatchObject({
      ok: true,
      result: { worktree: { path: '/receiver/b', hostId: 'local' } }
    })
  })
})
