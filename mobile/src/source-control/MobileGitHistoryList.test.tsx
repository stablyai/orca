import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { MobileGitHistoryList } from './MobileGitHistoryList'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: ({
    data,
    renderItem
  }: {
    data: { id: string }[]
    renderItem: (info: { item: { id: string } }) => ReactElement
  }) =>
    createElement(
      'FlatList',
      null,
      data.map((item) => createElement('Row', { key: item.id }, renderItem({ item })))
    ),
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))
vi.mock('../transport/client-context', () => ({ useForceReconnect: () => vi.fn() }))

function historyResponse(subject: string) {
  return {
    ok: true,
    result: {
      items: [{ id: 'commit-1', displayId: 'c0mm1t1', subject, author: 'Ada', parentIds: [] }]
    }
  }
}

const compareResponse = {
  ok: true,
  result: { entries: [{ path: 'src/app.ts', added: 3, removed: 1 }] }
}

describe('MobileGitHistoryList', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function listElement(client: RpcClient | null, connState: ConnectionState) {
    return createElement(MobileGitHistoryList, {
      client,
      connState,
      worktreeId: 'wt-1',
      hostId: 'host-1',
      bottomInset: 0
    })
  }

  async function render(client: RpcClient, connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer = create(listElement(client, connState))
      await Promise.resolve()
    })
  }

  async function update(client: RpcClient | null, connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(listElement(client, connState))
      await Promise.resolve()
    })
  }

  function tree(): string {
    return JSON.stringify(renderer?.toJSON())
  }

  it('keeps loaded commits visible across a disconnect and its reconnect refetch', async () => {
    let releaseRefetch: (() => void) | null = null
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(historyResponse('first load'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefetch = () => resolve(historyResponse('after reconnect'))
          })
      )
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('first load')

    await update(client, 'reconnecting')
    expect(tree()).toContain('first load')

    // The refetch is in flight: old rows must stay up instead of flashing empty.
    await update(client, 'connected')
    expect(tree()).toContain('first load')

    await act(async () => {
      releaseRefetch?.()
      await Promise.resolve()
    })
    expect(tree()).toContain('after reconnect')
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('wipes commits when the worktree identity changes', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(historyResponse('worktree one'))
      .mockReturnValueOnce(new Promise(() => {}))
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('worktree one')

    await act(async () => {
      renderer?.update(
        createElement(MobileGitHistoryList, {
          client,
          connState: 'connected',
          worktreeId: 'wt-2',
          hostId: 'host-1',
          bottomInset: 0
        })
      )
    })
    expect(tree()).not.toContain('worktree one')
  })

  it('refetches the expanded commit files after a reconnect instead of caching the outage answer', async () => {
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'git.history') {
        return Promise.resolve(historyResponse('expandable'))
      }
      return Promise.resolve(compareResponse)
    })
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    await update(client, 'disconnected')

    const row = renderer?.root.findAll(
      (node) => node.type === 'Pressable' && node.props.onPress !== undefined
    )[0]
    await act(async () => {
      row?.props.onPress()
    })
    // Offline expand cannot request anything, so nothing is cached as "no file changes".
    expect(tree()).toContain('Waiting for desktop...')
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await update(client, 'connected')
    expect(sendRequest).toHaveBeenCalledWith('git.commitCompare', {
      worktree: 'id:wt-1',
      commitId: 'commit-1'
    })
    expect(tree()).toContain('src/app.ts')
  })
})
