import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../src/shared/worktree/naming/retired-name-registry'
import { useRetiredWorktreeNames } from './use-retired-worktree-names'

type Pending = { resolve: (response: unknown) => void }

// Defer RPC replies to control both their repo and arrival order.
function mountNames() {
  const pending: Pending[] = []
  let latest: RetiredNameRegistry = EMPTY_RETIRED_NAME_REGISTRY

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook only calls this fixture's deferred sendRequest method.
  const client = {
    sendRequest: () => new Promise<unknown>((resolve) => pending.push({ resolve }))
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
    get names(): readonly string[] {
      return latest.names
    },
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
    }
  }
}

describe('useRetiredWorktreeNames', () => {
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
