import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { CodexSessionCollection } from './codex-session-root-dedup'
import { canStopParsingSessions } from './session-scan-cutoff'
import { createAccumulator, finalizeSession, sessionSortTime } from './session-scanner-accumulator'

function session(time: number | string, overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  const parsed = finalizeSession(
    createAccumulator({
      agent: 'claude',
      sessionId: 'session',
      file: { path: '/sessions/session.jsonl', mtimeMs: 0, modifiedAt: new Date(0).toISOString() }
    }),
    'linux'
  )
  if (!parsed) {
    throw new Error('Expected a session fixture')
  }
  return Object.freeze({
    ...parsed,
    updatedAt: typeof time === 'number' ? new Date(time).toISOString() : time,
    ...overrides
  })
}

function collection(rows: AiVaultSession[]): CodexSessionCollection {
  const result = new CodexSessionCollection()
  rows.forEach((row) => result.add(row))
  return result
}

function sortedReference(rows: AiVaultSession[], limit: number, next: number | undefined): boolean {
  if (rows.length < limit || typeof next !== 'number') {
    return false
  }
  const cutoff = rows
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)
  return typeof cutoff === 'number' && next < cutoff
}

afterEach(() => vi.restoreAllMocks())

describe('canStopParsingSessions', () => {
  it('counts strictly newer rows without sorting or mutating their order', () => {
    const rows = [session(8), session(2), session(6), session(4)]
    const sessions = collection(rows)
    const sort = vi.spyOn(Array.prototype, 'sort')
    expect(canStopParsingSessions(sessions, 2, 5)).toBe(true)
    expect(canStopParsingSessions(sessions, 2, 6)).toBe(false)
    expect(canStopParsingSessions(sessions, 4, 1)).toBe(true)
    expect(canStopParsingSessions(sessions, 4, 2)).toBe(false)
    expect(sort).not.toHaveBeenCalled()
    expect([...sessions.values()]).toEqual(rows)
  })

  it('does not visit rows before the unique-session budget is met', () => {
    const sessions = collection([session(5)])
    const values = vi.spyOn(sessions, 'values')
    expect(canStopParsingSessions(sessions, 2, 0)).toBe(false)
    expect(canStopParsingSessions(sessions, Number.POSITIVE_INFINITY, 0)).toBe(false)
    expect(canStopParsingSessions(sessions, 1, undefined)).toBe(false)
    expect(values).not.toHaveBeenCalled()
  })

  it('recounts a preferred alias even when replacement lowers its timestamp', () => {
    const alias = {
      agent: 'codex' as const,
      sessionId: 'same',
      filePath: '/sessions/rollout-same.jsonl'
    }
    const sessions = collection([session(100, { ...alias, codexHome: '/custom' }), session(100)])
    expect(canStopParsingSessions(sessions, 2, 50)).toBe(true)
    const preferred = session(10, { ...alias, codexHome: null })
    sessions.add(preferred)
    expect(sessions.size).toBe(2)
    expect(canStopParsingSessions(sessions, 2, 50)).toBe(false)
    sessions.add(preferred)
    expect(sessions.size).toBe(3)
    expect(canStopParsingSessions(sessions, 3, 9)).toBe(true)
  })

  it('preserves the legacy sort result when a later timestamp is invalid', () => {
    const rows = [session(0), session('invalid'), session(20)]
    const sessions = collection(rows)
    expect(canStopParsingSessions(sessions, 1, 10)).toBe(false)
    for (const candidate of [rows, rows.toReversed(), [rows[2], rows[0], rows[1]]]) {
      for (const limit of [1, 2, 3]) {
        for (const next of [-1, 0, 10, 20]) {
          expect(canStopParsingSessions(collection(candidate), limit, next)).toBe(
            sortedReference(candidate, limit, next)
          )
        }
      }
    }
  })

  it('parses timestamps only once when an invalid date appears at the end', () => {
    const sessions = collection([session(10), session(5), session('invalid')])
    const parse = vi.spyOn(Date, 'parse')
    canStopParsingSessions(sessions, 1, 0)
    expect(parse).toHaveBeenCalledTimes(3)
  })

  it('uses the same nullish modified-time fallback and numeric limit semantics', () => {
    const rows = [
      session('', { updatedAt: null, modifiedAt: '1970-01-01T00:00:02+00:00' }),
      session('-000001-01-01T00:00:00Z'),
      session('+010000-01-01T00:00:00Z'),
      session(0)
    ]
    for (const limit of [0, -1, -5, 0.5, 1.5, Number.NaN, Infinity, -Infinity, 1, 2, 4, 5]) {
      for (const next of [undefined, Number.NaN, -Infinity, Infinity, -1, 0, 1, 2000]) {
        expect(canStopParsingSessions(collection(rows), limit, next)).toBe(
          sortedReference(rows, limit, next)
        )
      }
    }
  })
})
