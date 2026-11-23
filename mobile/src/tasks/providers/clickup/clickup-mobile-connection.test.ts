import { describe, expect, it } from 'vitest'
import {
  DISCONNECTED_CLICKUP_CONNECTION,
  extractClickUpConnection,
  reconcileClickUpConnection
} from './clickup-mobile-connection'

const status = {
  connected: true,
  viewer: { id: '1', username: 'Ada', email: 'ada@example.com' },
  workspaces: [
    { id: 'w1', name: 'Acme' },
    { id: 'w2', name: 'Beta', color: '#ff0000' }
  ],
  selectedWorkspaceId: 'w2'
}

describe('extractClickUpConnection', () => {
  it('reads the host selection from a connected status', () => {
    const connection = extractClickUpConnection(status)
    expect(connection.connected).toBe(true)
    expect(connection.selectedWorkspaceId).toBe('w2')
    expect(connection.workspaces.map((workspace) => workspace.name)).toEqual(['Acme', 'Beta'])
  })

  it('falls back to the first Workspace when the selection is not among them', () => {
    expect(extractClickUpConnection({ ...status, selectedWorkspaceId: 'gone' })).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'w1'
    })
  })

  it('keeps an unreadable credential visible on a disconnected status', () => {
    expect(
      extractClickUpConnection({ connected: false, credentialError: ' cannot decrypt ' })
    ).toEqual({ ...DISCONNECTED_CLICKUP_CONNECTION, credentialError: 'cannot decrypt' })
  })

  it('asks for a newer host when the status is not the shape ClickUp reports', () => {
    const connection = extractClickUpConnection({ nope: true })
    expect(connection.connected).toBe(false)
    expect(connection.unavailableReason).toContain('Update Orca')
  })
})

describe('reconcileClickUpConnection', () => {
  const connected = extractClickUpConnection(status)

  it('marks a connection that disappeared under a read that worked before', () => {
    const next = extractClickUpConnection({ connected: false })
    expect(reconcileClickUpConnection(connected, next).lostConnection).toBe(true)
  })

  it('does not call a host that never had ClickUp a lost connection', () => {
    const next = extractClickUpConnection({ connected: false })
    expect(reconcileClickUpConnection(DISCONNECTED_CLICKUP_CONNECTION, next).lostConnection).toBe(
      false
    )
  })

  it('does not blame the connection when the host cannot report ClickUp at all', () => {
    const next = extractClickUpConnection(null)
    expect(reconcileClickUpConnection(connected, next).lostConnection).toBe(false)
  })
})
