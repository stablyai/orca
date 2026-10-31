import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { MobileCommitTimeline } from './MobileCommitTimeline'
import type { MobileTimelineRow } from './mobile-commit-timeline'
import { formatTimelineCommitTime } from './mobile-commit-timeline-time'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: ({
    data,
    renderItem
  }: {
    data: { key: string }[]
    renderItem: (info: { item: { key: string } }) => ReactElement
  }) =>
    createElement(
      'FlatList',
      null,
      data.map((item) => createElement('Row', { key: item.key }, renderItem({ item })))
    ),
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./MobileCommitTimelineRows', () => ({
  MobileCommitTimelineRow: ({
    row,
    nowMs,
    todayStartMs
  }: {
    row: MobileTimelineRow
    nowMs: number
    todayStartMs: number
  }) =>
    createElement(
      'Text',
      null,
      row.kind === 'commit'
        ? `${row.commit.subject} ${formatTimelineCommitTime(row.commit.timestamp, nowMs, todayStartMs)}`
        : row.kind
    )
}))
const transport = vi.hoisted(
  (): { forceReconnect: ((hostId: string) => Promise<void>) | null } => ({
    forceReconnect: () => Promise.resolve()
  })
)
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => transport.forceReconnect
}))

// Pin the clock to midday so a commit three hours back is still today.
vi.useFakeTimers({ toFake: ['Date'] })
vi.setSystemTime(new Date(2026, 9, 30, 12, 0))
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

const TIMELINE_PROPS = {
  settled: true,
  actionError: null,
  worktreeId: 'wt-1',
  hostId: 'host-1',
  bottomInset: 0,
  baseRef: null,
  baseMergeBase: null,
  base: null,
  headKey: 'head',
  upstream: null,
  uncommitted: null,
  pushAction: null,
  onOpenChanges: () => {},
  onOpenCommit: () => {}
}

describe('MobileCommitTimeline', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function listElement(client: RpcClient | null, connState: ConnectionState) {
    return createElement(MobileCommitTimeline, { ...TIMELINE_PROPS, client, connState })
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
    expect(tree()).toContain('3 hr')

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
        createElement(MobileCommitTimeline, {
          ...TIMELINE_PROPS,
          client,
          connState: 'connected',
          worktreeId: 'wt-2'
        })
      )
    })
    expect(tree()).not.toContain('worktree one')
  })
})
