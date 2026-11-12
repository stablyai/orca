import { describe, expect, it, vi } from 'vitest'
import type { StoredPortableSettings } from '../../../../shared/portable-settings'
import { importPortableSettings } from './runtime-portable-settings'

function storeWith(settings: StoredPortableSettings) {
  return { getSettings: () => settings, updateSettings: vi.fn() }
}

const incoming = { theme: 'dark', terminalFontSize: 13, workspaceDir: '/Users/other' }

describe('importPortableSettings', () => {
  it('writes only the changed settings, through the desktop Settings path', async () => {
    const store = storeWith({ theme: 'light', terminalFontSize: 13 })
    const desktopWriter = vi.fn(async () => undefined)

    await expect(
      importPortableSettings(store, desktopWriter, { settings: incoming })
    ).resolves.toEqual({ changed: ['theme'], skipped: ['workspaceDir'] })
    expect(desktopWriter).toHaveBeenCalledWith({ theme: 'dark' })
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('writes to the store on a host without a desktop window', async () => {
    const store = storeWith({ theme: 'light' })

    await importPortableSettings(store, null, { settings: incoming })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { theme: 'dark', terminalFontSize: 13 },
      { notifyListeners: true }
    )
  })

  it('reports a dry run without writing', async () => {
    const store = storeWith({ theme: 'light' })
    const desktopWriter = vi.fn(async () => undefined)

    await expect(
      importPortableSettings(store, desktopWriter, { settings: incoming, dryRun: true })
    ).resolves.toEqual({ changed: ['theme', 'terminalFontSize'], skipped: ['workspaceDir'] })
    expect(desktopWriter).not.toHaveBeenCalled()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })
})
