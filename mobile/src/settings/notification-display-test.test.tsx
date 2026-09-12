import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotificationDisplayTest } from './notification-display-test'

const mocks = vi.hoisted(() => ({
  loadHosts: vi.fn(),
  clients: [] as { state: string; client: { sendRequest: ReturnType<typeof vi.fn> } }[]
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} }
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: mocks.loadHosts }))
vi.mock('../transport/use-all-host-clients', () => ({ useAllHostClients: () => mocks.clients }))

let renderer: ReactTestRenderer
beforeEach(() => {
  mocks.loadHosts.mockReset().mockResolvedValue([{ id: 'first' }, { id: 'second' }])
  mocks.clients = []
})
afterEach(() => act(() => renderer?.unmount()))

async function send() {
  await act(async () => {
    renderer = create(createElement(NotificationDisplayTest, { onTroubleshoot: vi.fn() }))
  })
  await act(async () => renderer.root.findAllByType('Pressable')[0].props.onPress())
}

it.each([
  { ok: false, error: { code: 'method_not_found' } },
  { ok: false, error: { code: 'forbidden' } },
  { ok: true, result: { accepted: false, reason: 'not_registered' } }
])('tries the next desktop after a definitive non-delivery response %j', async (response) => {
  const first = vi.fn().mockResolvedValue(response)
  const second = vi.fn().mockResolvedValue({ ok: true, result: { accepted: true } })
  const third = vi.fn()
  mocks.clients = [first, second, third].map((sendRequest) => ({
    state: 'connected',
    client: { sendRequest }
  }))
  await send()
  expect(second).toHaveBeenCalledExactlyOnceWith('notifications.testPush', null, {
    timeoutMs: 20000,
    failWhenDisconnected: true
  })
  expect(third).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('Accepted by Orca’s push service')
})

it('does not try another desktop after an uncertain transport failure', async () => {
  const second = vi.fn()
  mocks.clients = [
    {
      state: 'connected',
      client: { sendRequest: vi.fn().mockRejectedValue(new Error('timeout')) }
    },
    { state: 'connected', client: { sendRequest: second } }
  ]
  await send()
  expect(second).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('timeout')
})

it('explains when every desktop needs registration or an update', async () => {
  mocks.clients = [
    { ok: true, result: { accepted: false, reason: 'not_registered' } },
    { ok: false, error: { code: 'method_not_found' } }
  ].map((response) => ({
    state: 'connected',
    client: { sendRequest: vi.fn().mockResolvedValue(response) }
  }))
  await send()
  expect(JSON.stringify(renderer.toJSON())).toContain('Reconnect to register this phone')
})

it.each([false, true])('explains missing pairing or connection (paired=%s)', async (paired) => {
  if (!paired) {
    mocks.loadHosts.mockResolvedValue([])
  }
  await send()
  expect(JSON.stringify(renderer.toJSON())).toContain(
    paired ? 'Connect a desktop' : 'Pair a desktop'
  )
})
