import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../src/shared/worktree/retired-name-registry'
import {
  buildRetiredWorktreeNamesRefreshKey,
  useRetiredWorktreeNames
} from './use-retired-worktree-names'

type Pending = { resolve: (response: unknown) => void; reject: (err: Error) => void }

/** Renders the hook against a deferred RPC client so a test decides exactly when each
 *  `worktree.listRetiredNames` lands, and for which repo. */
function mountNames() {
  const pending: Pending[] = []
  const requests: { method: string; params: unknown }[] = []
  let latest: RetiredNameRegistry = EMPTY_RETIRED_NAME_REGISTRY

  const client = {
    sendRequest: (method: string, params: unknown) => {
      requests.push({ method, params })
      return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }))
    }
  } as unknown as RpcClient

  function Probe({ repoId, refreshKey }: { repoId: string | null; refreshKey: string }) {
    latest = useRetiredWorktreeNames(client, repoId, refreshKey)
    return null
  }

  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe, { repoId: 'repo-1', refreshKey: 'a' }))
  })
  return {
    get registry(): RetiredNameRegistry {
      return latest
    },
    get names(): readonly string[] {
      return latest.names
    },
    requests,
    rerender(props: { repoId: string | null; refreshKey: string }) {
      act(() => {
        renderer.update(createElement(Probe, props))
      })
    },
    async settle(
      index: number,
      retiredNamesByRepo: Record<string, unknown>,
      retiredNameTiersByRepo: Record<string, unknown> = {}
    ) {
      await act(async () => {
        pending[index]!.resolve({ result: { retiredNamesByRepo, retiredNameTiersByRepo } })
        await Promise.resolve()
      })
    },
    async fail(index: number) {
      await act(async () => {
        pending[index]!.reject(new Error('host unreachable'))
        await Promise.resolve()
      })
    }
  }
}

describe('useRetiredWorktreeNames', () => {
  it('builds a stable refresh key without copied-array methods or input mutation', () => {
    const paths = ['/repo/zebra', '/repo/antelope']
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted')
    Reflect.deleteProperty(Array.prototype, 'toSorted')

    try {
      expect(buildRetiredWorktreeNamesRefreshKey(paths)).toBe('/repo/antelope\0/repo/zebra')
      expect(buildRetiredWorktreeNamesRefreshKey(undefined)).toBe('')
      expect(paths).toEqual(['/repo/zebra', '/repo/antelope'])
    } finally {
      if (descriptor) {
        Reflect.defineProperty(Array.prototype, 'toSorted', descriptor)
      }
    }
  })

  it('reads the selected repo out of the response envelope', async () => {
    const probe = mountNames()
    expect(probe.requests[0]).toEqual({
      method: 'worktree.listRetiredNames',
      params: { repo: 'id:repo-1' }
    })
    await probe.settle(0, { 'repo-1': ['nautilus'], 'repo-2': ['seahorse'] })
    expect(probe.names).toEqual(['nautilus'])
  })

  it('answers empty for a host that omits the field', async () => {
    const probe = mountNames()
    await probe.settle(0, {})
    expect(probe.registry).toEqual(EMPTY_RETIRED_NAME_REGISTRY)
  })

  it('carries the compaction watermark through, so spent tiers are not suggested back', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus-2'] }, { 'repo-1': 1 })
    expect(probe.registry).toEqual({ exhaustedTiers: 1, names: ['nautilus-2'] })
  })

  it('holds the watermark too when a refresh fails', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': [] }, { 'repo-1': 3 })

    probe.rerender({ repoId: 'repo-1', refreshKey: 'b' })
    await probe.fail(1)

    expect(probe.registry.exhaustedTiers).toBe(3)
  })

  // Regression: this hook used to reset to [] on any error, un-retiring every name for the rest of
  // the sheet session. Desktop always held the previous answer; both now share that rule.
  it('keeps previously loaded names when a refresh fails', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus'] })
    expect(probe.names).toEqual(['nautilus'])

    probe.rerender({ repoId: 'repo-1', refreshKey: 'b' })
    await probe.fail(1)

    expect(probe.names).toEqual(['nautilus'])
  })

  // Regression: the effect used to depend on [client, repoId] only, so a workspace created while
  // the sheet was open never made it into the pool.
  it('refetches when the workspace list changes', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus'] })

    probe.rerender({ repoId: 'repo-1', refreshKey: 'b' })
    expect(probe.requests).toHaveLength(2)
    // The previous answer stays visible while the refetch is in flight.
    expect(probe.names).toEqual(['nautilus'])

    await probe.settle(1, { 'repo-1': ['nautilus', 'seahorse'] })
    expect(probe.names).toEqual(['nautilus', 'seahorse'])
  })

  it('drops names when the repo changes rather than showing another repo pool', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus'] })

    probe.rerender({ repoId: 'repo-2', refreshKey: 'a' })
    expect(probe.names).toEqual([])
  })

  it('reports nothing without a selected repo, and asks the host nothing', () => {
    const probe = mountNames()
    probe.rerender({ repoId: null, refreshKey: 'a' })
    expect(probe.names).toEqual([])
    expect(probe.requests).toHaveLength(1)
  })
})
