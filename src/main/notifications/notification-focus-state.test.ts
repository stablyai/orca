import type * as NodeModule from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loadAddon, getFocusAssistState } = vi.hoisted(() => ({
  loadAddon: vi.fn(),
  getFocusAssistState: vi.fn()
}))

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeModule>()),
  createRequire: () => loadAddon
}))

import { isNotificationFocusActive } from './notification-focus-state'

describe('Windows notification Focus state', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    loadAddon.mockReset().mockReturnValue({ getFocusAssistState })
    getFocusAssistState.mockReset()
  })

  afterEach(() => Object.defineProperty(process, 'platform', platform))

  it.each([
    [0, false],
    [1, true],
    [2, true],
    [null, false]
  ])('maps native profile %s to suppression %s', async (profile, suppressed) => {
    getFocusAssistState.mockReturnValue(profile)
    await expect(isNotificationFocusActive()).resolves.toBe(suppressed)
  })

  it('keeps sounds enabled when the native addon cannot load', async () => {
    loadAddon.mockImplementation(() => {
      throw new Error('Native addon unavailable')
    })
    await expect(isNotificationFocusActive()).resolves.toBe(false)
  })
})
