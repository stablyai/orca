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
