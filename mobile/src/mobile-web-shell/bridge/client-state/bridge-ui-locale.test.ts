import { afterEach, expect, it } from 'vitest'
import { createFakeBridgePortPair } from '../test-support/bridge-port-pair-test-harness'
import { readBridgeHostMessage } from '../protocol/bridge-envelope'

let pair: ReturnType<typeof createFakeBridgePortPair> | null = null

afterEach(() => {
  pair?.client.close()
  pair?.host.dispose()
  pair = null
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
