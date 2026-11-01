import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
}))

const { confirmPluginExternalOpen, truncatedUrl } = await import('./plugin-external-open-consent')

function grantStore() {
  let settings: { pluginExternalHostGrants?: Record<string, string[]> } = {}
  return {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: typeof settings) => {
      settings = { ...settings, ...patch }
    })
  }
}

function confirm(store: ReturnType<typeof grantStore>, url: string, pluginId = 'acme.draw') {
  return confirmPluginExternalOpen({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window is only handed to the mocked dialog.
    window: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the consent reads and writes only pluginExternalHostGrants.
    store: store as never,
    pluginId,
    pluginName: 'Draw',
    url
  })
}

describe('confirmPluginExternalOpen', () => {
  it('asks per host, shows the URL, and opens only on Open', async () => {
    const store = grantStore()
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await expect(confirm(store, 'https://Evil.example/?d=secret')).resolves.toBe(false)
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: 'Draw wants to open evil.example',
        detail: 'https://evil.example/?d=secret',
        checkboxLabel: 'Always allow evil.example for this plugin',
        cancelId: 1,
        defaultId: 1
      })
    )
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await expect(confirm(store, 'https://evil.example/')).resolves.toBe(true)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('remembers "always allow" per plugin and host only', async () => {
    const store = grantStore()
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: true })
    await expect(confirm(store, 'https://docs.example/a')).resolves.toBe(true)
    showMessageBox.mockClear()
    await expect(confirm(store, 'https://docs.example/b')).resolves.toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(confirm(store, 'https://docs.example:8443/')).resolves.toBe(false)
    await expect(confirm(store, 'https://docs.example/', 'acme.other')).resolves.toBe(false)
    expect(store.getSettings().pluginExternalHostGrants).toEqual({ 'acme.draw': ['docs.example'] })
  })

  it('never asks about mailto:, and truncates long URLs', async () => {
    showMessageBox.mockClear()
    await expect(confirm(grantStore(), 'mailto:a@example.com?body=x')).resolves.toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
    const long = truncatedUrl(`https://x.example/?d=${'a'.repeat(1000)}`)
    expect(long).toHaveLength(300)
    expect(long.endsWith('…')).toBe(true)
  })
})
