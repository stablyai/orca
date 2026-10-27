import { afterEach, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

let pair: ReturnType<typeof createFakeBridgePortPair> | null = null

afterEach(() => {
  pair?.client.close()
  pair?.host.dispose()
  pair = null
})

it('reads an init without colorScheme as dark, then repaints once per scheme change in place', async () => {
  pair = createFakeBridgePortPair()
  await pair.flush()
  const init = pair.readToPage().find((frame) => frame.type === 'init')
  expect(init !== undefined && 'colorScheme' in init).toBe(false)
  const session = pair.client.getShellSession()
  expect(session?.colorScheme).toBe('dark')
  const seen: string[] = []
  pair.client.onColorSchemeUpdate((scheme) => seen.push(scheme))

  for (const scheme of ['light', 'light', 'dark'] as const) {
    pair.host.publishColorScheme(scheme)
    await pair.flush()
    expect(pair.client.getShellSession()?.colorScheme).toBe(scheme)
  }
  expect(seen).toEqual(['light', 'dark'])
  expect(pair.client.getShellSession()?.sessionId).toBe(session?.sessionId)
})
