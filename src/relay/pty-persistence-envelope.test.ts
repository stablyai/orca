import { describe, expect, it } from 'vitest'
import {
  MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES,
  parseRelayPtyPersistenceState,
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

function agentOwner(ptyId = 'pty-1') {
  return {
    claim: {
      digestVersion: 1 as const,
      keyId: 'claim-key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'codex' as const
    },
    generation: 'generation-1',
    phase: 'live' as const,
    ptyId,
    surface: {
      worktreeId: 'repo::/repo',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_abc123'
    }
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

  it('keeps the default array wire while round-tripping a strict v2 envelope', () => {
    const v2 = entry(1, {
      sourceIncarnationId: 'incarnation-1',
      replayTail: { data: 'tail', encoding: 'utf8', byteLength: 4, truncated: false },
      durableLaunch: {
        startupCommand: 'codex --resume session-1',
        shellOverride: '/bin/zsh',
        launchAgent: 'codex',
        startedAt: 42
      },
      agentOwners: [agentOwner()],
      providerSession: { key: 'session_id', id: 'session-1' },
      orchestrationTaskId: 'task-1'
    })

    const legacy = serializeRelayPtyPersistenceEnvelope([entry(1)], 50)
    const serialized = serializeRelayPtyPersistenceEnvelope([v2], 50, 2)

    expect(JSON.parse(legacy)).toBeInstanceOf(Array)
    expect(parseRelayPtyPersistenceState(serialized, 50)).toEqual({
      formatVersion: 2,
      entries: [v2]
    })
  })

  it('trims a v2 replay tail by UTF-8 bytes before dropping metadata', () => {
    const emojiTail = '😀'.repeat(25_600)
    const serialized = serializeRelayPtyPersistenceEnvelope(
      [
        entry(1, {
          sourceIncarnationId: 'incarnation-1',
          cwd: `/repo/${'x'.repeat(30 * 1024)}`,
          replayTail: {
            data: emojiTail,
            encoding: 'utf8',
            byteLength: Buffer.byteLength(emojiTail, 'utf8'),
            truncated: false
          },
          durableLaunch: { startupCommand: 'codex --resume session-1', launchAgent: 'codex' }
        })
      ],
      50,
      2
    )

    const parsed = parseRelayPtyPersistenceState(serialized, 50)
    const restored = parsed.entries[0]!
    expect(restored.cwd).toContain('/repo/')
    expect(restored.durableLaunch).toEqual({
      startupCommand: 'codex --resume session-1',
      launchAgent: 'codex'
    })
    expect(restored.replayTail).toMatchObject({ encoding: 'utf8', truncated: true })
    expect(Buffer.byteLength(restored.replayTail!.data, 'utf8')).toBe(
      restored.replayTail!.byteLength
    )
    expect(restored.replayTail!.data.endsWith('😀')).toBe(true)
  })

  it('rejects unknown v2 fields instead of guessing a version from entry shape', () => {
    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({
          schemaVersion: 2,
          entries: [{ ...entry(1), sourceIncarnationId: 'incarnation-1', unknown: true }]
        }),
        50
      )
    ).toThrow('unknown field')
    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({
          schemaVersion: 2,
          entries: [
            {
              ...entry(1),
              sourceIncarnationId: 'incarnation-1',
              attachIdentity: { paneKey: 'pane-1', unexpected: true }
            }
          ]
        }),
        50
      )
    ).toThrow('unknown field')
    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({
          schemaVersion: 2,
          entries: [
            {
              ...entry(1),
              sourceIncarnationId: 'incarnation-1',
              providerSession: { key: 'session_id', id: 'session-1', unexpected: true }
            }
          ]
        }),
        50
      )
    ).toThrow('unknown field')
  })

  it('rejects duplicate v2 PTY ids before serialization or parsing', () => {
    const v2 = entry(1, { sourceIncarnationId: 'incarnation-1' })

    expect(() => serializeRelayPtyPersistenceEnvelope([v2, { ...v2 }], 50, 2)).toThrow(
      'duplicate PTY ids'
    )
    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({ schemaVersion: 2, entries: [v2, { ...v2, cwd: '/other' }] }),
        50
      )
    ).toThrow('duplicate PTY ids')
  })

  it('rejects unknown nested agent-owner fields and mismatched owner PTY ids', () => {
    const v2 = entry(1, { sourceIncarnationId: 'incarnation-1' })

    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({
          schemaVersion: 2,
          entries: [
            {
              ...v2,
              agentOwners: [
                { ...agentOwner(), claim: { ...agentOwner().claim, hookPayload: 'private' } }
              ]
            }
          ]
        }),
        50
      )
    ).toThrow('unknown field')
    expect(() =>
      parseRelayPtyPersistenceState(
        JSON.stringify({
          schemaVersion: 2,
          entries: [{ ...v2, agentOwners: [agentOwner('other-pty')] }]
        }),
        50
      )
    ).toThrow('agent owner is invalid')
  })

  it('retains an explicit truncated replay-tail marker when an entry budget removes all data', () => {
    const replayTail = { data: 'tail', encoding: 'utf8' as const, byteLength: 4, truncated: false }
    const truncatedMarker = { data: '', encoding: 'utf8' as const, byteLength: 0, truncated: true }
    const v2 = entry(1, {
      cwd: 'c'.repeat(MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES),
      sourceIncarnationId: 'incarnation-1',
      durableLaunch: { startupCommand: '', launchAgent: 'codex' },
      replayTail
    })
    const fillBytes =
      MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES -
      Buffer.byteLength(JSON.stringify({ ...v2, replayTail: truncatedMarker }), 'utf8')
    v2.durableLaunch!.startupCommand = 'x'.repeat(fillBytes)

    const serialized = serializeRelayPtyPersistenceEnvelope([v2], 50, 2)

    expect(parseRelayPtyPersistenceState(serialized, 50).entries[0]?.replayTail).toEqual(
      truncatedMarker
    )
    v2.durableLaunch!.startupCommand = 'x'.repeat(fillBytes + 1)
    expect(() => serializeRelayPtyPersistenceEnvelope([v2], 50, 2)).toThrow(
      'cannot retain a truncated replay tail'
    )
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
