import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildResourceReservationBinding } from '../../shared/resource-reservation-binding'
import type { ResourceReservationRequest } from '../../shared/resource-reservation-binding'
import { TerminalReservationBindings } from './terminal-reservation-bindings'

const REQUEST: ResourceReservationRequest = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'terminal',
  ownershipGeneration: 1
}

describe('terminal reservation bindings', () => {
  it('binds once and replays the first binding for an identical retry', () => {
    const registry = new TerminalReservationBindings()
    const first = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    const second = buildResourceReservationBinding(REQUEST, { boundAt: 2 })

    expect(registry.bind('term_a', first)).toEqual({ outcome: 'bound' })
    expect(registry.bind('term_a', second)).toEqual({ outcome: 'replay', binding: first })
    expect(registry.get('term_a')).toEqual(first)
  })

  it('refuses the same key against a second terminal handle', () => {
    const registry = new TerminalReservationBindings()
    registry.bind('term_a', buildResourceReservationBinding(REQUEST, { boundAt: 1 }))

    const result = registry.bind('term_b', buildResourceReservationBinding(REQUEST, { boundAt: 2 }))

    expect(result.outcome).toBe('conflict')
  })

  it('refuses a reused key whose session changed before anything is created', () => {
    const registry = new TerminalReservationBindings()
    registry.bind('term_a', buildResourceReservationBinding(REQUEST, { boundAt: 1 }))

    expect(registry.assertBindable('term_a', { ...REQUEST, sessionId: 'session-2' })).toContain(
      'single-use'
    )
  })

  it('lets an untouched key bind', () => {
    const registry = new TerminalReservationBindings()

    expect(registry.assertBindable('term_a', REQUEST)).toBeNull()
  })

  it('reloads an immutable claim after runtime restart', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const first = new TerminalReservationBindings(profile)
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    first.claim('term_a', binding)

    const restarted = new TerminalReservationBindings(profile)
    expect(restarted.get('term_a')).toEqual(binding)
    expect(restarted.claim('term_a', { ...binding, boundAt: 2 })).toEqual({
      outcome: 'replay',
      binding
    })
  })

  it('rejects malformed persisted bindings instead of laundering them into runtime state', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    writeFileSync(
      join(profile, 'terminal-reservations.json'),
      JSON.stringify([{ handle: 'term_a', binding: { ...REQUEST, boundAt: -1 } }])
    )

    expect(() => new TerminalReservationBindings(profile)).toThrow(
      'Invalid terminal reservation store at entry 0'
    )
  })

  it('rejects a worktree binding persisted in the terminal-only store', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    writeFileSync(
      join(profile, 'terminal-reservations.json'),
      JSON.stringify([
        { handle: 'term_a', binding: { ...REQUEST, resourceKind: 'worktree', boundAt: 1 } }
      ])
    )

    expect(() => new TerminalReservationBindings(profile)).toThrow(
      'Invalid terminal reservation store at entry 0'
    )
  })

  it('rejects a worktree binding at the live terminal authority boundary', () => {
    const registry = new TerminalReservationBindings()
    const wrongKind = { ...REQUEST, resourceKind: 'worktree' as const, boundAt: 1 }

    expect(() => registry.claim('term_a', wrongKind)).toThrow(
      'Invalid terminal reservation binding'
    )
    expect(registry.get('term_a')).toBeUndefined()
  })

  it.each([
    [
      'handle',
      [
        { handle: 'term_a', binding: { ...REQUEST, boundAt: 1 } },
        { handle: 'term_a', binding: { ...REQUEST, key: 'key-2', boundAt: 2 } }
      ]
    ],
    [
      'key',
      [
        { handle: 'term_a', binding: { ...REQUEST, boundAt: 1 } },
        { handle: 'term_b', binding: { ...REQUEST, boundAt: 2 } }
      ]
    ]
  ])('rejects a duplicate persisted %s', (kind, entries) => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    writeFileSync(join(profile, 'terminal-reservations.json'), JSON.stringify(entries))

    expect(() => new TerminalReservationBindings(profile)).toThrow(`duplicate ${kind}`)
  })

  it('keeps existing state and persistence target when reconfiguration hydration fails', () => {
    const originalProfile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const corruptProfile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const registry = new TerminalReservationBindings(originalProfile)
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    registry.claim('term_a', binding)
    writeFileSync(join(corruptProfile, 'terminal-reservations.json'), JSON.stringify([null]))

    expect(() => registry.configurePersistence(corruptProfile)).toThrow()
    expect(registry.get('term_a')).toEqual(binding)

    registry.retire('term_a')
    expect(new TerminalReservationBindings(originalProfile).get('term_a')).toBeUndefined()
  })

  it('retires an explicitly destroyed terminal claim durably', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const registry = new TerminalReservationBindings(profile)
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    registry.claim('term_a', binding)

    registry.retire('term_a')

    expect(registry.get('term_a')).toBeUndefined()
    expect(new TerminalReservationBindings(profile).get('term_a')).toBeUndefined()
  })

  it('keeps memory and disk unchanged when release persistence fails', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const registry = new TerminalReservationBindings(profile)
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    registry.claim('term_a', binding)
    const storagePath = join(profile, 'terminal-reservations.json')
    const persisted = readFileSync(storagePath, 'utf8')
    chmodSync(profile, 0o500)

    try {
      expect(() => registry.release('term_a', binding)).toThrow()
      expect(registry.get('term_a')).toEqual(binding)
      expect(readFileSync(storagePath, 'utf8')).toBe(persisted)
    } finally {
      chmodSync(profile, 0o700)
    }
  })
})
