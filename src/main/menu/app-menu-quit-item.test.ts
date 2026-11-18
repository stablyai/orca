import { describe, expect, it, vi } from 'vitest'

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (key: string, _fallback: string, options?: { appName?: string }) =>
    options?.appName ? `${key}:${options.appName}` : key
}))

import { createAppMenuQuitItems } from './app-menu-quit-item'

describe('createAppMenuQuitItems', () => {
  it('localizes the native macOS Quit role item', () => {
    const items = createAppMenuQuitItems({ onQuitAndStopAllSessions: () => {} }, 'Orca')

    expect(items.at(-1)).toEqual({ role: 'quit', label: 'menu.quitApp:Orca' })
  })
})
