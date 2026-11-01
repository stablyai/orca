import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { readPluginDeclaredSettings, writePluginDeclaredSetting } from './plugin-declared-settings'

const settings = [
  { key: 'apiUrl', title: 'Server URL', type: 'string' as const, default: 'https://example.com' },
  { key: 'pageSize', title: 'Page size', type: 'integer' as const, minimum: 1 }
]

function host() {
  const plugin = { manifest: { contributes: { settings } } }
  return {
    findValidPlugin: (key: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings code reads only manifest.contributes.settings.
      key === 'acme.todos' ? (plugin as never as ValidDiscoveredPlugin) : null,
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-declared-settings-')),
    dataChanged: vi.fn()
  }
}

describe('declared plugin settings in Orca Settings', () => {
  it('shows defaults until the person sets a value, then theirs, and tells the plugin', () => {
    const settingsHost = host()
    expect(readPluginDeclaredSettings(settingsHost, 'acme.todos')?.values).toEqual({
      apiUrl: 'https://example.com'
    })
    expect(writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 50)).toEqual({
      ok: true
    })
    expect(settingsHost.dataChanged).toHaveBeenCalledWith('acme.todos', 'pageSize')
    expect(writePluginDeclaredSetting(settingsHost, 'acme.todos', 'apiUrl', null)).toEqual({
      ok: true
    })
    expect(readPluginDeclaredSettings(settingsHost, 'acme.todos')?.values).toEqual({
      apiUrl: 'https://example.com',
      pageSize: 50
    })
  })

  it('refuses undeclared keys and values that do not fit', () => {
    const settingsHost = host()
    expect(writePluginDeclaredSetting(settingsHost, 'acme.todos', 'other', 1)).toMatchObject({
      ok: false
    })
    expect(writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 0)).toEqual({
      ok: false,
      error: 'Page size must be at least 1'
    })
    expect(settingsHost.dataChanged).not.toHaveBeenCalled()
    expect(readPluginDeclaredSettings(settingsHost, 'acme.none')).toBeNull()
  })
})
