import { describe, expect, it } from 'vitest'
import { PluginPanelSessions } from './plugin-panel-sessions'

const binding = {
  pluginKey: 'orca-samples.demo',
  panelId: 'dashboard',
  surface: 'panel' as const,
  rootDir: '/plugins/orca-samples.demo/hash-one',
  manifestRevision: 'manifest-v1'
}

describe('PluginPanelSessions', () => {
  it('binds an opaque token to its transport owner and panel revision', () => {
    const sessions = new PluginPanelSessions()
    const token = sessions.issue('renderer:1', binding)

    expect(token).toHaveLength(43)
    expect(sessions.resolve('renderer:1', token)).toEqual(binding)
    expect(sessions.resolve('renderer:2', token)).toBeNull()
    expect(sessions.issue('renderer:1', binding)).toBe(token)
    expect(sessions.issue('renderer:1', { ...binding, rootDir: '/plugins/new' })).not.toBe(token)
    expect(sessions.issue('renderer:1', { ...binding, manifestRevision: 'manifest-v2' })).not.toBe(
      token
    )
    // A settings page with the same id is a different document and authority.
    expect(sessions.issue('renderer:1', { ...binding, surface: 'settingsPage' })).not.toBe(token)
  })

  it('revokes every session owned by a disconnected transport', () => {
    const sessions = new PluginPanelSessions()
    const first = sessions.issue('connection:one', binding)
    const second = sessions.issue('connection:one', { ...binding, panelId: 'secondary' })
    const other = sessions.issue('connection:two', binding)

    sessions.revokeOwner('connection:one')

    expect(sessions.resolve('connection:one', first)).toBeNull()
    expect(sessions.resolve('connection:one', second)).toBeNull()
    expect(sessions.resolve('connection:two', other)).toEqual(binding)
  })

  it('resolves a settings page session only for callers that accept settings pages', () => {
    const sessions = new PluginPanelSessions()
    const page = { ...binding, surface: 'settingsPage' as const }
    const token = sessions.issue('renderer:1', page)

    // Panel-only by default, so a panel-keyed channel never takes a page token.
    expect(sessions.resolve('renderer:1', token)).toBeNull()
    expect(sessions.resolve('renderer:1', token, ['panel'])).toBeNull()
    expect(sessions.resolve('renderer:1', token, ['panel', 'settingsPage'])).toEqual(page)
  })
})
