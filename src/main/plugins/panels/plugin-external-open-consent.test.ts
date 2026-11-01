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
  it('asks per host, shows the URL, and opens only on Open', async () => {
    const store = grantStore()
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await expect(confirm(store, 'https://Evil.example/?d=secret')).resolves.toBe('cancelled')
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
    await expect(confirm(store, 'https://evil.example/')).resolves.toBe('allowed')
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

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

  it('never asks about mailto:, and truncates long URLs', async () => {
    showMessageBox.mockClear()
    await expect(confirm(grantStore(), 'mailto:a@example.com?body=x')).resolves.toBe('allowed')
    expect(showMessageBox).not.toHaveBeenCalled()
    const long = truncatedUrl(`https://x.example/?d=${'a'.repeat(1000)}`)
    expect(long).toHaveLength(300)
    expect(long.endsWith('…')).toBe(true)
  })

  it('never prompts on a hidden or minimized window, and says why in the log', async () => {
    showMessageBox.mockClear()
    const log = vi.fn()
    const hidden = { visible: false, minimized: false }
    await expect(
      confirm(grantStore(), 'https://a.example/', 'acme.draw', hidden, log)
    ).resolves.toBe('unavailable')
    const minimized = { visible: true, minimized: true }
    await expect(confirm(grantStore(), 'https://a.example/', 'acme.draw', minimized)).resolves.toBe(
      'unavailable'
    )
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('window is hidden'))
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await confirm(grantStore(), 'https://a.example/', 'acme.draw', undefined, log)
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('waiting for the person to confirm')
    )
  })
})
