import { describe, expect, it } from 'vitest'
import { TerminalHostTombstones } from './terminal-host-tombstones'

describe('TerminalHostTombstones', () => {
  it('clears historical stop markers before a session identity is reused', () => {
    const tombstones = new TerminalHostTombstones(2)
    tombstones.record('session-1')

    tombstones.clearForCreate('session-1')

    expect(tombstones.has('session-1')).toBe(false)
  })

  it('bounds historical markers without turning them into process evidence', () => {
    const tombstones = new TerminalHostTombstones(2)
    tombstones.record('session-1')
    tombstones.record('session-2')
    tombstones.record('session-3')

    expect(tombstones.has('session-1')).toBe(false)
    expect(tombstones.has('session-2')).toBe(true)
    expect(tombstones.has('session-3')).toBe(true)
  })
})
