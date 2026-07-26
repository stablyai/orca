import { describe, expect, it } from 'vitest'
import {
  MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES,
  parseRelayPtyPersistenceEnvelope,
  serializeRelayPtyPersistenceEnvelope,
  type RelayPtyPersistenceEntry
} from './pty-persistence-envelope'
import { MAX_TERMINAL_COLS } from '../shared/terminal-size-limits'

function entry(index: number, overrides: Partial<RelayPtyPersistenceEntry> = {}) {
  return {
    id: `pty-${index}`,
    pid: 100 + index,
    cols: 80,
    rows: 24,
    cwd: '/repo',
    envToDelete: [],
    gitCredentialPromptGuarded: false,
    ...overrides
  }
}

describe('relay PTY persistence envelope', () => {
  it('round-trips normal state without changing retained fields', () => {
    const entries = [
      entry(1, {
        paneKey: 'tab-1:leaf-1',
        attachIdentity: { paneKey: 'tab-1:leaf-1', tabId: 'tab-1' },
        worktreeId: 'repo::/repo',
        terminalHandle: 'terminal-1',
        explicitTerm: 'screen-256color',
        envToDelete: ['ORCA_ATTRIBUTION_SHIM_DIR'],
        gitCredentialPromptGuarded: true
      })
    ]

    const serialized = serializeRelayPtyPersistenceEnvelope(entries, 50)

    expect(parseRelayPtyPersistenceEnvelope(serialized, 50)).toEqual(entries)
  })

  it('accepts the field limit and rejects limit plus one', () => {
    expect(() =>
      serializeRelayPtyPersistenceEnvelope(
        [entry(1, { cwd: 'x'.repeat(MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES) })],
        50
      )
    ).not.toThrow()
    expect(() =>
      serializeRelayPtyPersistenceEnvelope(
        [entry(1, { cwd: 'x'.repeat(MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES + 1) })],
        50
      )
    ).toThrow(`exceeds ${MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES} bytes`)
  })

  it('rejects aggregate retained fields before serialization allocates the output', () => {
    const field = 'x'.repeat(63 * 1024)
    const entries = Array.from({ length: 49 }, (_, index) =>
      entry(index, { cwd: field, paneKey: field })
    )

    expect(() => serializeRelayPtyPersistenceEnvelope(entries, 50)).toThrow(
      `exceeds ${MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES} retained bytes`
    )
  })

  it('rejects oversized and deeply nested input before JSON.parse', () => {
    expect(() =>
      parseRelayPtyPersistenceEnvelope(' '.repeat(MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES + 1), 50)
    ).toThrow(`exceeds ${MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES} bytes`)

    const deeplyNested = JSON.stringify([
      {
        ...entry(1),
        ignored: [[[[[[[[]]]]]]]]
      }
    ])
    expect(() => parseRelayPtyPersistenceEnvelope(deeplyNested, 50)).toThrow(
      'JSON nesting exceeds 8 levels'
    )
  })

  it('rejects entry-count overflow transactionally', () => {
    const serialized = JSON.stringify([entry(1), entry(2)])
    expect(() => parseRelayPtyPersistenceEnvelope(serialized, 1)).toThrow(
      'PTY persistence state exceeds 1 entries'
    )
  })

  it('rejects oversized terminal dimensions on writes and reads', () => {
    const oversized = entry(1, { cols: MAX_TERMINAL_COLS + 1 })
    expect(() => serializeRelayPtyPersistenceEnvelope([oversized], 50)).toThrow(
      `1 through ${MAX_TERMINAL_COLS}`
    )
    expect(() => parseRelayPtyPersistenceEnvelope(JSON.stringify([oversized]), 50)).toThrow(
      `1 through ${MAX_TERMINAL_COLS}`
    )
  })
})
