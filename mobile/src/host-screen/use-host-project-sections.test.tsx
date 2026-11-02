import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../transport/rpc-client'
import { useHostProjectSections } from './use-host-project-sections'

import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

const catalog = (name: string) => ({
  repos: [],
  projects: [{ id: name, displayName: name }],
  setups: [],
  projectOrderBy: 'manual',
  projectGroups: []
})
const reply = (name: string): RpcResponse => ({
  id: 'r',
  ok: true,
  result: { catalog: catalog(name) },
  _meta: { runtimeId: 'runtime' }
})
afterEach(() => {
  unmountRenderers()
  vi.useRealTimers()
})

describe('useHostProjectSections', () => {
  it('fetches immediately on another host client while throttling the original client', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const first = new FakeSession('connected')
    const second = new FakeSession('connected')
    first.sendRequest.mockResolvedValue(reply('first'))
    second.sendRequest.mockResolvedValue(reply('second'))
    const clientRef: { current: RpcClient | null } = { current: first }
    const served: unknown[] = []
    let refresh = async () => {}
    function Probe({ client, hostId }: { client: RpcClient; hostId: string }) {
      refresh = useHostProjectSections({
        client,
        connState: 'connected',
        hostId,
        state: {
          clientRef,
          setServedProjectSections: (value) => served.push(value),
          setHostProjectGroups: () => {}
        }
      })
      return null
    }
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(createElement(Probe, { client: first, hostId: 'a' }))
    })
    await act(async () => refresh())
    await act(async () => refresh())
    expect(first.sendRequest.mock.calls).toEqual([['mobileRelay.projectSections']])
    clientRef.current = second
    act(() => tree.update(createElement(Probe, { client: second, hostId: 'b' })))
    await act(async () => refresh())
    expect(second.sendRequest.mock.calls).toEqual([['mobileRelay.projectSections']])
    expect(served).toEqual([catalog('first'), catalog('second')])
  })

  it('reads again after an invalidation during an in-flight catalog read', async () => {
    const client = new FakeSession('connected')
    let answerFirst: ((reply: RpcResponse) => void) | undefined
    client.sendRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve
      })
    )
    client.sendRequest.mockResolvedValueOnce(reply('moved'))
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
          clientRef: { current: client },
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
    await act(async () => refresh({ force: true, queueIfInFlight: true }))
    await act(async () => {
      if (answerFirst === undefined) {
        throw new Error('first catalog request never entered')
      }
      answerFirst(reply('before'))
      await first
    })
    expect(client.sendRequest.mock.calls).toEqual([
      ['mobileRelay.projectSections'],
      ['mobileRelay.projectSections']
    ])
    expect(served).toEqual([catalog('before'), catalog('moved')])
  })

  it('reads nothing while the sidebar feed carries the catalog', async () => {
    const client = new FakeSession('connected')
    let refresh = async () => {}
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
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
