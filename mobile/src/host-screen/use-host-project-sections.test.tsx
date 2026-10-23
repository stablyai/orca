import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('../worktree/project-sections-operations', () => ({
  projectSectionsRead: { request },
  readServedProjectSections: (reply: { catalog?: unknown } | null) => ({
    kind: 'answered',
    value: reply?.catalog ?? null
  })
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
        state: { clientRef, setServedProjectSections: () => {}, setHostProjectGroups: () => {} }
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

  it('reads again after a read in flight when an invalidation arrives during it', async () => {
    request.mockReset()
    let answerFirst: (reply: unknown) => void = () => {}
    request.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
    request.mockResolvedValueOnce({ ok: true, catalog: 'moved' })
    const client = clientDouble()
    const clientRef: { current: RpcClient | null } = { current: client }
    const served: unknown[] = []
    let refresh: (options?: {
      force?: boolean
      queueIfInFlight?: boolean
    }) => Promise<void> = async () => {}
    function Probe() {
      refresh = useHostProjectSections({
        client,
        connState: 'connected',
        hostId: 'a',
        state: {
          clientRef,
          setServedProjectSections: (value) => served.push(value),
          setHostProjectGroups: () => {}
        }
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    let first!: Promise<void>
    act(() => {
      first = refresh({ force: true, queueIfInFlight: true })
    })
    // reposChanged while the first read is in flight: that read may predate the move.
    await act(async () => refresh({ force: true, queueIfInFlight: true }))
    await act(async () => {
      answerFirst({ ok: true, catalog: 'before' })
      await first
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(served).toEqual(['before', 'moved'])
  })

  it('reads nothing while the sidebar feed carries the catalog', async () => {
    request.mockReset()
    const client = clientDouble()
    let refresh: () => Promise<void> = async () => {}
    function Probe() {
      refresh = useHostProjectSections({
        client,
        connState: 'connected',
        hostId: 'a',
        state: {
          clientRef: { current: client },
          setServedProjectSections: () => {},
          setHostProjectGroups: () => {}
        },
        feedCarriesCatalog: () => true
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    await act(async () => refresh())
    expect(request).not.toHaveBeenCalled()
  })
})
