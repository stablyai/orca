import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../src/shared/worktree/retired-name-registry'
import { useRetiredWorktreeNames } from './use-retired-worktree-names'

type Pending = { resolve: (response: unknown) => void; reject: (err: Error) => void }

// Defer RPC replies to control both their repo and arrival order.
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
        // Include the real host’s ok field so acceptance exercises success rather than refusal.
        pending[index]!.resolve({
          ok: true,
          result: { retiredNamesByRepo, retiredNameTiersByRepo }
        })
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
  // Match desktop: refresh failure must not un-retire every name for the rest of the sheet session.
  it('keeps previously loaded names when a refresh fails', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus'] })
    expect(probe.names).toEqual(['nautilus'])

    probe.rerender({ repoId: 'repo-1', refreshKey: 'b' })
    await probe.fail(1)

    expect(probe.names).toEqual(['nautilus'])
  })

  it('drops names when the repo changes rather than showing another repo pool', async () => {
    const probe = mountNames()
    await probe.settle(0, { 'repo-1': ['nautilus'] })

    probe.rerender({ repoId: 'repo-1', refreshKey: 'b' })
    probe.rerender({ repoId: 'repo-2', refreshKey: 'a' })
    expect(probe.names).toEqual([])
    await probe.settle(2, { 'repo-2': ['seahorse'] })
    await probe.settle(1, { 'repo-1': ['nautilus', 'marlin'] })
    expect(probe.names).toEqual(['seahorse'])
  })
})
