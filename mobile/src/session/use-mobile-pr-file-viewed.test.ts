import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRFile } from '../../../src/shared/github/pull-request-types'
import type { RpcResponse } from '../transport/types'

import { useMobilePrFileViewed } from './use-mobile-pr-file-viewed'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

const FILES: GitHubPRFile[] = [
  { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, isBinary: false }
]

function reply(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'r' } }
}

describe('useMobilePrFileViewed', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function toggle(hostReply: RpcResponse) {
    let release!: () => void
    const sent = new Promise<void>((resolve) => {
      release = resolve
    })
    const sendRequest = vi.fn(async () => {
      await sent
      return hostReply
    })
    const setFileViewedState = vi.fn()
    let setViewed!: ReturnType<typeof useMobilePrFileViewed>['setViewed']
    function Harness(): null {
      setViewed = useMobilePrFileViewed({
        client: stubRpcClient({ sendRequest }),
        connState: 'connected',
        worktreeId: 'wt-1',
        prNumber: 7,
        pullRequestId: 'PR_1',
        prRepo: null,
        files: FILES,
        setFileViewedState
      }).setViewed
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    let done!: Promise<void>
    act(() => {
      done = setViewed('a.ts', true)
    })
    // A second tap while the first is in flight must not send another write.
    act(() => {
      void setViewed('a.ts', false)
    })
    release()
    await act(async () => {
      await done
    })
    return { sendRequest, states: setFileViewedState.mock.calls.map((call) => call[2]) }
  }

  it('marks at once and again once GitHub confirms, so a refetch mid-request cannot undo it', async () => {
    const { sendRequest, states } = await toggle(reply(true))
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(states).toEqual(['VIEWED', 'VIEWED'])
  })

  it('rolls back to the previous state when GitHub refuses', async () => {
    const { states } = await toggle(reply(false))
    expect(states).toEqual(['VIEWED', 'UNVIEWED'])
  })
})
