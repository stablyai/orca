import { describe, expect, it } from 'vitest'
import { formatHostList, type HostListEntry } from './format'

const ssh: HostListEntry = { kind: 'ssh', id: 'ssh-1', name: 'box', selector: '--host ssh:ssh-1' }

describe('host list text output', () => {
  it.each([
    [{}, 'connection unknown'],
    [{ connected: true, connectionStatus: 'connected' }, 'connected'],
    [{ connected: false, connectionStatus: 'disconnected' }, 'not connected'],
    [{ connected: false, connectionStatus: 'reconnecting' }, 'not connected (reconnecting)'],
    [{ connected: false, connectionStatus: 'auth-failed' }, 'not connected (auth-failed)']
  ] as const)('shows SSH metadata %j truthfully', (metadata, expected) => {
    const output = formatHostList({ hosts: [{ ...ssh, ...metadata }] })
    expect(output).toContain(` ${expected}  ->`)
    expect(output).toContain('platform unknown')
    expect(output).not.toContain('connected (connected)')
  })

  it('prints incomplete-inventory warnings in human output', () => {
    expect(formatHostList({ hosts: [], warnings: ['SSH inventory unavailable'] })).toBe(
      'Warning: SSH inventory unavailable'
    )
  })
})
