import { describe, expect, it } from 'vitest'
import { attributePairingLogPath } from './pairing-log-path'
import type { ConnectionLogEntry } from './types'

const entry: ConnectionLogEntry = {
  id: 'log-1',
  ts: 1,
  level: 'warn',
  message: 'Reconnecting (attempt 2)',
  detail: '10.5.0.2:6768'
}

describe('attributePairingLogPath', () => {
  it('prefixes unlabelled lines with their pairing path', () => {
    const entries: ConnectionLogEntry[] = []
    attributePairingLogPath('direct', (value) => entries.push(value))!(entry)

    expect(entries).toEqual([{ ...entry, message: 'Direct: Reconnecting (attempt 2)' }])
  })

  it('leaves a line that already names its path unchanged', () => {
    const entries: ConnectionLogEntry[] = []
    const relayEntry = { ...entry, message: 'Relay: cell dial failed' }
    attributePairingLogPath('relay', (value) => entries.push(value))!(relayEntry)

    expect(entries).toEqual([relayEntry])
  })

  it('labels relay lines that forgot their own prefix', () => {
    const entries: ConnectionLogEntry[] = []
    attributePairingLogPath('relay', (value) => entries.push(value))!(entry)

    expect(entries[0]!.message).toBe('Relay: Reconnecting (attempt 2)')
  })

  it('stays undefined when there is no sink to attribute to', () => {
    expect(attributePairingLogPath('direct', undefined)).toBeUndefined()
  })
})
