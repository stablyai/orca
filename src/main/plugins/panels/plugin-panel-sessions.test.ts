import { describe, expect, it, vi } from 'vitest'
import { PluginPanelSessions } from './plugin-panel-sessions'

const binding = {
  pluginKey: 'samples.demo',
  surface: 'panel' as const,
  contributionId: 'dashboard',
  rootDir: '/plugins/samples.demo/hash-one',
  manifestRevision: 'manifest-v1'
}

describe('PluginPanelSessions', () => {
  it('binds an opaque token to its transport owner and panel revision', () => {
    const sessions = new PluginPanelSessions()
    const token = sessions.issue('renderer:1', binding)

    expect(token).toHaveLength(43)
    const resolved = sessions.resolve('renderer:1', token)
    expect(resolved).toEqual({ ...binding, publicId: expect.stringMatching(/^[\w-]{12}$/) })
    expect(resolved?.publicId).not.toContain(token.slice(0, 12))
    expect(sessions.resolve('renderer:2', token)).toBeNull()
    expect(sessions.issue('renderer:1', binding)).toBe(token)
    expect(sessions.issue('renderer:1', { ...binding, rootDir: '/plugins/new' })).not.toBe(token)
    expect(sessions.issue('renderer:1', { ...binding, manifestRevision: 'manifest-v2' })).not.toBe(
      token
    )
    // An editor with the same id as a panel is a different contribution.
    expect(sessions.issue('renderer:1', { ...binding, surface: 'editor' })).not.toBe(token)
  })

  it('revokes every session owned by a disconnected transport', () => {
    const sessions = new PluginPanelSessions()
    const first = sessions.issue('connection:one', binding)
    const second = sessions.issue('connection:one', { ...binding, contributionId: 'secondary' })
    const other = sessions.issue('connection:two', binding)

    sessions.revokeOwner('connection:one')

    expect(sessions.resolve('connection:one', first)).toBeNull()
    expect(sessions.resolve('connection:one', second)).toBeNull()
    expect(sessions.resolve('connection:two', other)).toMatchObject(binding)
  })

  it('reports each closed session by its public id, never the token', () => {
    const onClosed = vi.fn()
    const sessions = new PluginPanelSessions(onClosed)
    const token = sessions.issue('renderer:1', binding)
    const { publicId } = sessions.resolve('renderer:1', token)!
    sessions.revoke('renderer:1', token)
    expect(onClosed).toHaveBeenCalledWith(publicId)
    sessions.issue('renderer:1', binding)
    sessions.clear()
    expect(onClosed).toHaveBeenCalledTimes(2)
  })
})
