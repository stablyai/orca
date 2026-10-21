import { describe, expect, it } from 'vitest'
import { buildSshHostHealthById, getHostHealthBadgeLabel } from './worktree-host-health'

describe('buildSshHostHealthById', () => {
  it('derives each SSH host health from its lifecycle, keyed by canonical host id', () => {
    const health = buildSshHostHealthById([
      { id: 'up', connected: true, connectionStatus: 'connected' },
      { id: 'relay', connected: false, connectionStatus: 'deploying-relay' },
      { id: 'retry', connected: false, connectionStatus: 'reconnecting' },
      { id: 'down', connected: false, connectionStatus: 'disconnected' },
      { id: 'auth', connected: false, connectionStatus: 'auth-failed' },
      { id: 'never', connected: false },
      { id: 'ssh:canonical', connected: false, connectionStatus: 'connecting' }
    ])
    expect(Object.fromEntries(health)).toEqual({
      'ssh:up': 'available',
      'ssh:relay': 'connecting',
      'ssh:retry': 'connecting',
      'ssh:down': 'disconnected',
      'ssh:auth': 'error',
      // Same verdict as the desktop sidebar for a target with no lifecycle state yet.
      'ssh:never': 'disconnected',
      'ssh:canonical': 'connecting'
    })
  })

  it('reports nothing for a desktop that predates lifecycle fields or a status it cannot read', () => {
    const health = buildSshHostHealthById([
      { id: 'old-desktop' },
      { id: 'future', connected: false, connectionStatus: 'hibernating' }
    ])
    expect(health.size).toBe(0)
  })
})

describe('getHostHealthBadgeLabel', () => {
  it('uses the desktop sidebar words for unhealthy hosts only', () => {
    expect(getHostHealthBadgeLabel('disconnected')).toBe('Disconnected')
    expect(getHostHealthBadgeLabel('connecting')).toBe('Connecting')
    expect(getHostHealthBadgeLabel('error')).toBe('Needs attention')
    expect(getHostHealthBadgeLabel('blocked')).toBe('Update needed')
    expect(getHostHealthBadgeLabel('available')).toBeUndefined()
    expect(getHostHealthBadgeLabel('local')).toBeUndefined()
    expect(getHostHealthBadgeLabel(undefined)).toBeUndefined()
  })
})
