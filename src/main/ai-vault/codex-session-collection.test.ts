import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { CodexSessionCollection, dedupeCodexSessionsBySessionId } from './codex-session-root-dedup'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  const parsed = finalizeSession(
    createAccumulator({
      agent: 'codex',
      sessionId: 'session',
      file: {
        path: '/home/ada/.codex/rollout-session.jsonl',
        mtimeMs: 1000,
        modifiedAt: '1970-01-01T00:00:01.000Z'
      }
    }),
    'linux'
  )
  if (!parsed) {
    throw new Error('Expected a session fixture')
  }
  return Object.freeze({ ...parsed, ...overrides })
}

function checkBatches(batches: AiVaultSession[][]): AiVaultSession[] {
  const collection = new CodexSessionCollection()
  let expected: AiVaultSession[] = []
  for (const batch of batches) {
    expected = dedupeCodexSessionsBySessionId([...expected, ...batch])
    for (const value of batch) {
      collection.add(value)
    }
    const actual = [...collection.values()]
    expect(collection.size).toBe(expected.length)
    expect(actual).toHaveLength(expected.length)
    actual.forEach((value, index) => expect(value).toBe(expected[index]))
  }
  return [...collection.values()]
}

describe('CodexSessionCollection', () => {
  it('keeps winner occurrences in input order across replacements and batches', () => {
    const other = session({ agent: 'claude' })
    const real = session()
    const managed = session({ codexHome: '/tmp/codex-runtime-home/home' })
    const custom = session({ codexHome: '/tmp/custom' })
    expect(
      checkBatches([
        [custom, other, custom],
        [managed, other, managed],
        [custom],
        [real, other, real]
      ])
    ).toEqual([other, other, real, other, real])
  })

  it('keeps identical winning objects, not distinct tied objects', () => {
    const first = session()
    const tied = session()
    expect(
      checkBatches([
        [first, tied, first],
        [tied, first]
      ])
    ).toEqual([first, first, first])
  })

  it('retains non-Codex and non-rollout occurrences unchanged', () => {
    const claude = session({ agent: 'claude' })
    const otherFile = session({ filePath: '/tmp/session.jsonl' })
    expect(
      checkBatches([
        [claude, otherFile],
        [claude, otherFile]
      ])
    ).toEqual([claude, otherFile, claude, otherFile])
  })

  it('preserves timestamp, root, path tie-breaks and invalid-date comparisons', () => {
    const older = session({ updatedAt: '1970-01-01T00:00:00Z' })
    const newer = session({ updatedAt: '1970-01-01T00:00:03Z' })
    const smallerPath = session({ ...newer, filePath: '/a/rollout-session.jsonl' })
    const invalid = session({ modifiedAt: 'invalid' })
    const account = session({ codexHome: '/tmp/codex-accounts/account/home' })
    const custom = session({ codexHome: '/tmp/custom' })
    expect(checkBatches([[custom], [account], [older], [newer], [smallerPath]])).toEqual([
      smallerPath
    ])
    expect(
      checkBatches([
        [invalid, older],
        [newer, smallerPath]
      ])
    ).toEqual([invalid])
    expect(checkBatches([[older], [invalid], [newer]])).toEqual([newer])
  })

  it('isolates execution hosts, WSL distros, parsed ids and rollout names', () => {
    const native = session()
    const ssh = session({ executionHostId: 'ssh:dev' })
    const ubuntu = session({ filePath: '\\\\wsl$\\Ubuntu\\home\\ada\\rollout-session.jsonl' })
    const ubuntuAlias = session({
      filePath: '\\\\wsl.localhost\\ubuntu\\home\\ada\\rollout-session.jsonl',
      codexHome: '/custom'
    })
    const debian = session({ filePath: '\\\\wsl$\\Debian\\home\\ada\\rollout-session.jsonl' })
    const otherId = session({ sessionId: 'other' })
    const otherName = session({ filePath: '/tmp/rollout-other.jsonl' })
    expect(
      checkBatches([
        [native, ssh, ubuntu],
        [ubuntuAlias, debian, otherId, otherName]
      ])
    ).toEqual([native, ssh, ubuntu, debian, otherId, otherName])
  })

  it('does not rescan retained rows on admission', () => {
    let pathReads = 0
    const collection = new CodexSessionCollection()
    for (let index = 0; index < 1000; index++) {
      const value = session({ sessionId: `session-${index}` })
      collection.add({
        ...value,
        get filePath() {
          pathReads++
          return value.filePath
        }
      })
    }
    expect(collection.size).toBe(1000)
    expect([...collection.values()]).toHaveLength(1000)
    expect(pathReads).toBeLessThanOrEqual(2000)
  })
})
