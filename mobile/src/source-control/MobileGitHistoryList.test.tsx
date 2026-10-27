import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
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
const transport = vi.hoisted(
  (): { forceReconnect: ((hostId: string) => Promise<void>) | null } => ({
    forceReconnect: () => Promise.resolve()
  })
)
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => transport.forceReconnect
}))

// Capture now before render so a few milliseconds cannot move the relative-time bucket.
const RENDER_NOW = Date.now()

function historyResponse(subject: string): RpcResponse {
  return {
    id: 'history',
    ok: true,
    result: {
      items: [
        {
          id: 'commit-1',
          displayId: 'c0mm1t1',
          subject,
          author: 'Ada',
          parentIds: [],
          timestamp: RENDER_NOW - 3 * 3_600_000
        }
      ]
    }
  }
}

const compareResponse: RpcResponse = {
  id: 'compare',
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
    // RPC timestamps are epoch milliseconds; seconds rescaling would show every commit as just now.
    expect(tree()).toContain('3h')

    await update(client, 'reconnecting')
    expect(tree()).toContain('first load')

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
      (node) => String(node.type) === 'Pressable' && node.props.onPress !== undefined
    )[0]
    await act(async () => {
      row?.props.onPress()
    })
    // Offline expansion must not cache an outage as an empty file list.
    expect(tree()).toContain('Waiting for desktop...')
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await update(client, 'connected')
    expect(sendRequest).toHaveBeenCalledWith('git.commitCompare', {
      worktree: 'id:wt-1',
      commitId: 'commit-1'
    })
    expect(tree()).toContain('src/app.ts')
  })

  it.each(['refusal', 'transport', 'malformed'])(
    'shows a retryable %s instead of claiming the commit has no changes',
    async (failure) => {
      let attempts = 0
      const client = createFakeRpcClient()
      client.sendRequest = vi.fn(async (method): Promise<RpcResponse> => {
        if (method === 'git.history') {
          return historyResponse('expandable')
        }
        attempts += 1
        if (attempts > 1) {
          return compareResponse
        }
        if (failure === 'transport') {
          throw new Error('Connection lost')
        }
        if (failure === 'malformed') {
          return { id: 'compare', ok: true, result: {} }
        }
        return {
          id: 'compare',
          ok: false,
          error: { code: 'runtime_error', message: 'Unable to read commit' }
        }
      })
      await render(client, 'connected')
      await act(async () => {
        renderer?.root.findAll((node) => String(node.type) === 'Pressable')[0]?.props.onPress()
      })
      expect(tree()).not.toContain('No file changes')
      expect(tree()).not.toContain('ActivityIndicator')
      const retry = renderer?.root.findAll(
        (node) =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'Retry commit files'
      )[0]
      expect(retry).toBeDefined()
      await act(async () => retry?.props.onPress())
      expect(tree()).toContain('src/app.ts')
      expect(tree()).not.toContain('Retry commit files')
    }
  )

  it('keeps previously loaded files when their reconnect refresh is refused', async () => {
    let attempts = 0
    const client = createFakeRpcClient()
    client.sendRequest = vi.fn(async (method): Promise<RpcResponse> => {
      if (method === 'git.history') {
        return historyResponse('expandable')
      }
      attempts += 1
      return attempts === 1
        ? compareResponse
        : {
            id: 'compare',
            ok: false,
            error: { code: 'runtime_error', message: 'Commit refresh failed' }
          }
    })
    await render(client, 'connected')
    await act(async () =>
      renderer?.root.findAll((node) => String(node.type) === 'Pressable')[0]?.props.onPress()
    )
    await update(client, 'reconnecting')
    await update(client, 'connected')
    expect(tree()).toContain('src/app.ts')
    expect(tree()).toContain('Commit refresh failed')
    expect(tree()).not.toContain('No file changes')
  })

  describe('Retry while the host is unreachable', () => {
    function retryControls() {
      return (
        renderer?.root.findAll(
          (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Retry'
        ) ?? []
      )
    }

    async function renderUnreachable(): Promise<void> {
      await act(async () => {
        renderer = create(listElement(null, 'reconnecting'))
        await Promise.resolve()
      })
    }

    afterEach(() => {
      transport.forceReconnect = () => Promise.resolve()
    })

    it('is absent on the page, where nothing can re-dial', async () => {
      transport.forceReconnect = null
      await renderUnreachable()
      expect(tree()).toContain('Waiting for desktop...')
      expect(retryControls()).toHaveLength(0)
    })

    it('still renders natively and re-dials this host', async () => {
      const forceReconnect = vi.fn(() => Promise.resolve())
      transport.forceReconnect = forceReconnect
      await renderUnreachable()
      await act(async () => {
        retryControls()[0]?.props.onPress()
      })
      expect(forceReconnect.mock.calls).toEqual([['host-1']])
    })

    it('loads again when the shell reconnects, which is what the missing Retry relies on', async () => {
      transport.forceReconnect = null
      await renderUnreachable()
      expect(retryControls()).toHaveLength(0)
      const client = createFakeRpcClient()
      await update(client, 'connected')
      expect(client.requests.map((request) => request.method)).toEqual(['git.history'])
    })
  })
})
