import { describe, expect, it } from 'vitest'
import {
  DISCONNECTED_CLICKUP_CONNECTION,
  INITIAL_CLICKUP_CONNECTION,
  clickUpHostUpdateRequiredConnection,
  extractClickUpConnection,
  readClickUpConnectionProbeReply,
  reconcileClickUpConnection,
  reconcileClickUpReadFailure
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
    const next = clickUpHostUpdateRequiredConnection()
    expect(reconcileClickUpConnection(connected, next).lostConnection).toBe(false)
  })
})

describe('reconcileClickUpReadFailure', () => {
  it('marks a first read that failed as unreachable instead of disconnected', () => {
    expect(reconcileClickUpReadFailure(INITIAL_CLICKUP_CONNECTION).readState).toBe('unreachable')
  })

  it('keeps a disconnected status that loaded before', () => {
    const disconnected = extractClickUpConnection({ connected: false })
    expect(reconcileClickUpReadFailure(disconnected)).toBe(disconnected)
  })
})

describe('readClickUpConnectionProbeReply', () => {
  it('reads a connected status reply', () => {
    const connection = readClickUpConnectionProbeReply({ id: '1', ok: true, result: status })
    expect(connection).toMatchObject({ connected: true, selectedWorkspaceId: 'w2' })
  })

  it('rejects when the host refuses the request, so the caller keeps its last connection', () => {
    expect(() =>
      readClickUpConnectionProbeReply({
        id: '1',
        ok: false,
        error: { code: 'runtime_error', message: 'ClickUp is unreachable' }
      })
    ).toThrow('could not read the ClickUp connection status')
  })

  it('asks for a newer host when the reply is not the status shape', () => {
    const connection = readClickUpConnectionProbeReply({
      id: '1',
      ok: true,
      result: { nope: true }
    })
    expect(connection.unavailableReason).toContain('Update Orca')
  })
})
