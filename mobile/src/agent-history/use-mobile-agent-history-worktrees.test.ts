import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useMobileAgentHistoryWorktrees } from './use-mobile-agent-history-worktrees'

describe('useMobileAgentHistoryWorktrees', () => {
  let renderer: ReactTestRenderer | null = null
  let latest = { worktrees: [] as Worktree[], worktreesLoaded: false }
  let consoleSpy: MockInstance

  function Harness(props: { client: Pick<RpcClient, 'sendRequest'>; connected?: boolean }): null {
    latest = useMobileAgentHistoryWorktrees(props.client, props.connected ?? true)
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    latest = { worktrees: [], worktreesLoaded: false }
    const original = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    consoleSpy.mockRestore()
  })

  it('hides a previous client snapshot while the next client loads', async () => {
    const firstWorktree = worktree('first')
    const secondWorktree = worktree('second')
    const firstClient = clientWithResponse(success([firstWorktree]))
    const secondResponse = deferred<RpcResponse>()
    const secondClient = clientWithResponse(secondResponse.promise)

    await render(firstClient)
    expect(latest).toEqual({ worktrees: [firstWorktree], worktreesLoaded: true })

    act(() => renderer?.update(createElement(Harness, { client: secondClient })))
    expect(latest).toEqual({ worktrees: [], worktreesLoaded: false })

    await act(async () => {
      secondResponse.resolve(success([secondWorktree]))
      await Promise.resolve()
    })
    expect(latest).toEqual({ worktrees: [secondWorktree], worktreesLoaded: true })
  })

  it('ignores a response from a replaced client', async () => {
    const firstResponse = deferred<RpcResponse>()
    const secondResponse = deferred<RpcResponse>()
    const firstClient = clientWithResponse(firstResponse.promise)
    const secondClient = clientWithResponse(secondResponse.promise)
    await render(firstClient)

    act(() => renderer?.update(createElement(Harness, { client: secondClient })))
    await act(async () => {
      firstResponse.resolve(success([worktree('stale')]))
      await Promise.resolve()
    })
    expect(latest).toEqual({ worktrees: [], worktreesLoaded: false })

    await act(async () => {
      secondResponse.resolve(success([worktree('current')]))
      await Promise.resolve()
    })
    expect(latest.worktrees[0]?.worktreeId).toBe('current')
  })

  it('finishes loading without scope data when the request fails', async () => {
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new Error('offline'))
    } as Pick<RpcClient, 'sendRequest'>

    await render(client)

    expect(latest).toEqual({ worktrees: [], worktreesLoaded: true })
  })

  async function render(client: Pick<RpcClient, 'sendRequest'>): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }
})

function clientWithResponse(response: Promise<RpcResponse> | RpcResponse) {
  return {
    sendRequest: vi.fn().mockResolvedValue(response)
  } as Pick<RpcClient, 'sendRequest'>
}

function success(worktrees: Worktree[]): RpcResponse {
  return {
    id: 'response',
    ok: true,
    result: { worktrees },
    _meta: { runtimeId: 'runtime' }
  }
}

function worktree(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo',
    repo: 'repo',
    branch: worktreeId,
    displayName: worktreeId,
    path: `/repo/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle
    }),
    resolve
  }
}
