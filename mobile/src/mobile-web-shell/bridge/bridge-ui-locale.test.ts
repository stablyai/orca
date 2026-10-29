import { afterEach, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { readBridgeHostMessage } from './bridge-envelope'

let pair: ReturnType<typeof createFakeBridgePortPair> | null = null

afterEach(() => {
  pair?.client.close()
  pair?.host.dispose()
  pair = null
})

it('reads an init without uiLocale as unknown, then follows each language change in place', async () => {
  pair = createFakeBridgePortPair()
  await pair.flush()
  const init = pair.readToPage().find((frame) => frame.type === 'init')
  expect(init !== undefined && 'uiLocale' in init).toBe(false)
  const session = pair.client.getShellSession()
  expect(session?.uiLocale).toBeNull()
  const seen: (string | null)[] = []
  pair.client.onUiLocaleUpdate((locale) => seen.push(locale))

  for (const locale of ['ja', 'ja', 'en'] as const) {
    pair.host.publishUiLocale(locale)
    await pair.flush()
    expect(pair.client.getShellSession()?.uiLocale).toBe(locale)
  }
  expect(seen).toEqual(['ja', 'en'])
  expect(pair.client.getShellSession()?.sessionId).toBe(session?.sessionId)
})

it('keeps an init whose language this page does not ship', async () => {
  pair = createFakeBridgePortPair()
  await pair.flush()
  const init = pair.readToPage().find((frame) => frame.type === 'init')
  const read = readBridgeHostMessage(JSON.stringify({ ...init, uiLocale: 'it' }))
  expect(read.ok).toBe(true)
  expect(
    read.ok && read.message.type === 'init' ? read.message.uiLocale : 'refused'
  ).toBeUndefined()
})
