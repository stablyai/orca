import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { documentQueryClient } from '../../../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { useMobileDiffReviewSnapshot } from './use-mobile-diff-review-snapshot'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

const WORKTREE = 'repo-m::/r/wt'
let renderer: ReactTestRenderer | undefined
const queries = documentQueryClient()

afterEach(async () => {
  act(() => renderer?.unmount())
  renderer = undefined
  await queries.end()
})

it('re-reads the branch compare when a desktop git change moves the base but not status', async () => {
  let branchFiles = ['a.ts', 'b.ts']
  let emit: (event: unknown) => void = () => {}
  const results: Record<string, unknown> = {
    'git.status': {
      entries: [],
      conflictOperation: 'unknown',
      head: 'h1',
      branch: 'refs/heads/wt'
    },
    'worktree.show': { worktree: { baseRef: 'main', branch: 'refs/heads/wt', head: 'h1' } },
    'repo.list': { repos: [] },
    'settings.get': { settings: {} }
  }
  const client = stubRpcClient({
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    subscribe: (_method, _params, onData) => {
      emit = onData
      return () => {}
    },
    sendRequest: async (method): Promise<RpcResponse> => ({
      id: 'r',
      ok: true,
      result:
        method === 'git.branchCompare'
          ? {
              summary: {
                baseRef: 'main',
                compareRef: 'HEAD',
                changedFiles: branchFiles.length,
                status: 'ready',
                headOid: 'h1',
                mergeBase: branchFiles.length === 2 ? 'm1' : 'm2'
              },
              entries: branchFiles.map((path) => ({ path, status: 'modified' }))
            }
          : results[method]
    })
  })
  let shown: string[] | undefined
  function Review(): null {
    const { screenState } = useMobileDiffReviewSnapshot({
      client,
      connState: 'connected',
      hostId: 'h',
      worktreeId: WORKTREE,
      commitOid: null,
      filter: 'all',
      setActionError: () => {}
    })
    shown =
      screenState.kind === 'ready'
        ? screenState.branchCompare?.entries?.map((entry) => entry.path)
        : undefined
    return null
  }
  await act(async () => {
    renderer = create(queries.wrap(createElement(Review)))
  })
  act(() => emit({ type: 'ready', subscriptionId: 's' }))
  await vi.waitFor(() => expect(shown).toEqual(['a.ts', 'b.ts']))

  // a.ts was merged into main from another checkout; this worktree's status is unchanged.
  branchFiles = ['b.ts']
  act(() => emit({ type: 'gitStatusChanged', repoId: 'repo-m' }))

  await vi.waitFor(() => expect(shown).toEqual(['b.ts']), { timeout: 3_000 })
})
