import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileGitRequests } from './use-mobile-git-requests'

vi.mock('../components/HostProtocolGate', () => ({
  useHostProtocolGates: () => ({ gitRemoteOperationTimeoutMs: 100 })
}))

afterEach(() => vi.useRealTimers())

describe('useMobileGitRequests', () => {
  it('uses one configured deadline across multi-step sync transport', async () => {
    vi.useFakeTimers()
    const sendRequest = vi.fn(
      (method: string) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                result: method === 'git.upstreamStatus' ? { ahead: 0, behind: 0 } : undefined
              }),
            method === 'git.fetch' ? 60 : 50
          )
        })
    )
    const client = { sendRequest } as unknown as RpcClient
    let requests: ReturnType<typeof useMobileGitRequests> | null = null
    let renderer: ReactTestRenderer | null = null

    function Probe(): null {
      requests = useMobileGitRequests({ client, connState: 'connected', worktreeId: 'wt-1' })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Probe))
      })
      let settled = false
      const operation = requests!
        .runGitSyncSteps()
        .catch(() => {})
        .finally(() => {
          settled = true
        })

      await act(async () => vi.advanceTimersByTimeAsync(100))

      expect(settled).toBe(true)
      expect(sendRequest).toHaveBeenNthCalledWith(
        2,
        'git.pull',
        { worktree: 'id:wt-1', operationTimeoutMs: 40 },
        { timeoutMs: 40 }
      )
      await operation
    } finally {
      await act(async () => {
        renderer?.unmount()
      })
    }
  })
})
