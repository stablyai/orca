import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
}))

const { confirmPluginExternalOpen } = await import('./plugin-external-open-consent')

function grantStore() {
  let settings: { pluginExternalHostGrants?: Record<string, string[]> } = {}
  return {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: typeof settings) => {
      settings = { ...settings, ...patch }
    })
  }
}

type FakeWindow = { visible: boolean; minimized: boolean }

function confirm(
  store: ReturnType<typeof grantStore>,
  url: string,
  pluginId = 'acme.draw',
  shown: FakeWindow = { visible: true, minimized: false },
  log?: (line: string) => void
) {
  const window = {
    isDestroyed: () => false,
    isVisible: () => shown.visible,
    isMinimized: () => shown.minimized
  }
  return confirmPluginExternalOpen({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: consent reads only these three window methods and hands it to the mocked dialog.
    window: window as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the consent reads and writes only pluginExternalHostGrants.
    store: store as never,
    pluginId,
    pluginName: 'Draw',
    url,
    log
  })
}

describe('confirmPluginExternalOpen', () => {
  it('remembers "always allow" per plugin and host only', async () => {
    const store = grantStore()
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: true })
    await expect(confirm(store, 'https://docs.example/a')).resolves.toBe('allowed')
    showMessageBox.mockClear()
    await expect(confirm(store, 'https://docs.example/b')).resolves.toBe('allowed')
    expect(showMessageBox).not.toHaveBeenCalled()
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(confirm(store, 'https://docs.example:8443/')).resolves.toBe('cancelled')
    await expect(confirm(store, 'https://docs.example/', 'acme.other')).resolves.toBe('cancelled')
    expect(store.getSettings().pluginExternalHostGrants).toEqual({ 'acme.draw': ['docs.example'] })
  })
})
