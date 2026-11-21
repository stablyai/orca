import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import type { MobileComposio } from './mobile-composio-store'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))

// The refresh reads once as it starts; notices and the foreground are host-bot-refresh's own tests.
vi.mock('../../../../bots/host-bot-refresh', () => ({
  startHostBotRefresh: ({ refresh }: { refresh: () => void }) => {
    refresh()
    return () => {}
  }
}))

type Asked = { client: RpcClient; answer: (key: string) => void }
const asked = vi.hoisted((): Asked[] => [])

vi.mock('./mobile-composio-operations', () => ({
  composioStatusRead: {
    request: (client: RpcClient) =>
      new Promise((resolve) => {
        asked.push({ client, answer: (key) => resolve({ key, added: true }) })
      }),
    interpret: (response: unknown) => response
  },
  composioConnectionsRead: {
    request: async () => ({ connections: [], pending: [{ app: 'gmail', url: 'https://sign.in' }] }),
    interpret: (response: unknown) => response
  }
}))

const { rereadMobileComposio, useMobileComposio } = await import('./mobile-composio-store')

const clientA = stubRpcClient()
const clientB = stubRpcClient()
let seen: MobileComposio | null = null
const shown: ReactTestRenderer[] = []

function Card({ client, botId }: { client: RpcClient; botId: string }): null {
  seen = useMobileComposio(client, 'host', botId)
  return null
}

async function show(client: RpcClient, botId: string): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(Card, { client, botId }))
  })
  if (!renderer) {
    throw new Error('the card did not render')
  }
  shown.push(renderer)
  return renderer
}

async function answer(index: number, key: string): Promise<void> {
  await act(async () => {
    asked[index]!.answer(key)
  })
}

afterEach(async () => {
  await act(async () => {
    for (const renderer of shown.splice(0)) {
      renderer.unmount()
    }
  })
  asked.length = 0
  seen = null
})

describe('useMobileComposio', () => {
  it('lets go of the client when the last card leaves and keeps the view, sign-ins included', async () => {
    const card = await show(clientA, 'atlas')
    await answer(0, 'ok')
    expect(seen?.connections?.pending).toEqual([{ app: 'gmail', url: 'https://sign.in' }])
    await act(async () => card.unmount())

    rereadMobileComposio('host', 'atlas')
    expect(asked).toHaveLength(1)

    await show(clientB, 'atlas')
    expect(seen?.status?.key).toBe('ok')
    // A sign-in still waiting shows as waiting, not as Connect, which would restart it on the host.
    expect(seen?.connections?.pending).toEqual([{ app: 'gmail', url: 'https://sign.in' }])
    expect(asked.map((entry) => entry.client)).toEqual([clientA, clientB])
    await answer(1, 'ok')
    expect(seen?.connections?.pending).toEqual([{ app: 'gmail', url: 'https://sign.in' }])
  })

  it('drops a reply read through the client of a showing that has ended', async () => {
    const card = await show(clientA, 'nova')
    await act(async () => card.unmount())
    await show(clientB, 'nova')
    await answer(0, 'rejected')
    expect(seen?.status).toBeNull()
    await answer(1, 'ok')
    expect(seen?.status?.key).toBe('ok')
  })

  it('keeps a reply read through the same client a new showing holds', async () => {
    const card = await show(clientA, 'vega')
    await act(async () => card.unmount())
    await show(clientA, 'vega')
    await answer(0, 'ok')
    expect(seen?.status?.key).toBe('ok')
  })
})
