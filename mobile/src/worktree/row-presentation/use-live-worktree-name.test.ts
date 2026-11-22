import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { useLiveWorktreeName, type LiveWorktreeName } from './use-live-worktree-name'

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => (() => void) | void) => useEffect(effect, [effect]) }
})

it('shows the live workspace name when the host takes longer than the fallback interval', async () => {
  vi.useFakeTimers()
  const worktreeId = 'repo-1::/work/feature'
  const replies: ((response: RpcResponse) => void)[] = []
  const client = stubRpcClient({
    sendRequest: () => new Promise<RpcResponse>((resolve) => replies.push(resolve))
  })
  let value: LiveWorktreeName | undefined
  let renderer: ReturnType<typeof create> | undefined
  function Workspace(): null {
    value = useLiveWorktreeName({
      client,
      connState: 'connected',
      worktreeId,
      routeName: 'feature'
    })
    return null
  }
  try {
    await act(async () => {
      renderer = create(createElement(Workspace))
    })
    expect(value).toMatchObject({ name: 'feature', resolution: 'unknown' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000)
    })
    await act(async () => {
      replies[0]?.({
        id: 'worktree',
        ok: true,
        _meta: { runtimeId: 'host' },
        result: { worktree: { worktreeId, displayName: 'Renamed workspace' } }
      })
    })
    expect(value).toMatchObject({ name: 'Renamed workspace', resolution: 'present' })
  } finally {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  }
})
