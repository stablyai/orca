import { describe, expect, it, vi } from 'vitest'

vi.mock('../profile-storage/browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: vi.fn()
}))

const { getSidePanelOptionsForTab, isUsableSidePanel, setSidePanelOptions } =
  await import('./browser-extension-side-panel-options')

function extension(id: string, manifest: Record<string, unknown>): Electron.Extension {
  return { id, name: id, version: '1', path: '/x', url: '', manifest }
}

describe('side panel options', () => {
  it('starts global options from the manifest and merges later changes', () => {
    const ext = extension('a'.repeat(32), { side_panel: { default_path: 'panel.html' } })
    expect(getSidePanelOptionsForTab('p', ext, null)).toEqual({ path: 'panel.html', enabled: true })

    setSidePanelOptions('p', ext, { enabled: false })
    expect(getSidePanelOptionsForTab('p', ext, null)).toEqual({
      path: 'panel.html',
      enabled: false
    })
  })

  it('gives a tab its own options without the global page, as Chrome does', () => {
    const ext = extension('b'.repeat(32), { side_panel: { default_path: 'panel.html' } })
    setSidePanelOptions('p', ext, { tabId: 7, enabled: true })

    const tabOptions = getSidePanelOptionsForTab('p', ext, 7)
    expect(tabOptions).toEqual({ enabled: true })
    expect(isUsableSidePanel(tabOptions)).toBe(false)
    expect(getSidePanelOptionsForTab('p', ext, 8)).toEqual({ path: 'panel.html', enabled: true })

    setSidePanelOptions('p', ext, { tabId: 7, path: 'tab.html?tabId=7' })
    expect(getSidePanelOptionsForTab('p', ext, 7)).toEqual({
      path: 'tab.html?tabId=7',
      enabled: true
    })
  })
})
