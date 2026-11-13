import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { ScannedSessionCollection } from './session-root-dedup'
import { canStopParsingSessions } from './session-scan-cutoff'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'

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

function collection(rows: AiVaultSession[]): ScannedSessionCollection {
  const result = new ScannedSessionCollection()
  rows.forEach((row) => result.add(row))
  return result
}

describe('canStopParsingSessions', () => {
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
})
