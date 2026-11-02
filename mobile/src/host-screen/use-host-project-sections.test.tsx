import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('../worktree/project-sections-operations', () => ({
  projectSectionsRead: { request },
  readServedProjectSections: () => ({ kind: 'answered', value: null })
}))

import type { RpcClient } from '../transport/rpc-client'
import { useHostProjectSections } from './use-host-project-sections'

function clientDouble(): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only compares the client by identity and hands it to the mocked read.
  return {} as RpcClient
}

describe('useHostProjectSections', () => {
  it('fetches the catalog at once when the screen moves to another host client', async () => {
    request.mockResolvedValue({ ok: true })
    const clientRef: { current: RpcClient | null } = { current: null }
    let refresh: (options?: { force?: boolean }) => Promise<void> = async () => {}
    function Probe({ client, hostId }: { client: RpcClient; hostId: string }) {
      refresh = useHostProjectSections({
        client,
        connState: 'connected',
        hostId,
        state: { clientRef, setServedProjectSections: () => {} }
      })
      return null
    }
    const first = clientDouble()
    const second = clientDouble()
    clientRef.current = first
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(createElement(Probe, { client: first, hostId: 'a' }))
    })
    await act(async () => refresh())
    await act(async () => refresh())
    expect(request).toHaveBeenCalledTimes(1)

    clientRef.current = second
    act(() => tree.update(createElement(Probe, { client: second, hostId: 'b' })))
    await act(async () => refresh())
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith(second)
  })
})
