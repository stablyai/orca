import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_SESSION_INDEX_HEAL_VERSION,
  CodexSessionIndexHealCapacityError,
  collectPendingHealThreads,
  isHealMarkerCurrent,
  MAX_CODEX_SESSION_INDEX_HEAL_MARKER_FILE_BYTES,
  MAX_CODEX_SESSION_INDEX_HEAL_TRACKED_THREADS,
  type CodexSessionIndexHealPaths
} from './codex-session-index-heal-state'

describe('Codex session index heal state memory bounds', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makePaths(): CodexSessionIndexHealPaths {
    const root = mkdtempSync(join(tmpdir(), 'orca-heal-state-memory-'))
    roots.push(root)
    return {
      auditLogPath: join(root, 'audit.jsonl'),
      systemSessionsRoot: '/sessions',
      healLedgerPath: join(root, 'heal.jsonl'),
      healMarkerPath: join(root, 'marker.json')
    }
  }

  it('fails closed when processed state exceeds the retained-thread ceiling', () => {
    const paths = makePaths()
    const descriptor = openSync(paths.healLedgerPath, 'w')
    try {
      for (let start = 0; start <= MAX_CODEX_SESSION_INDEX_HEAL_TRACKED_THREADS; start += 1000) {
        const count = Math.min(1000, MAX_CODEX_SESSION_INDEX_HEAL_TRACKED_THREADS + 1 - start)
        const lines = Array.from({ length: count }, (_, offset) => {
          const suffix = (start + offset).toString(16).padStart(12, '0')
          return JSON.stringify({
            v: CODEX_SESSION_INDEX_HEAL_VERSION,
            systemSessionsRoot: paths.systemSessionsRoot,
            threadId: `00000000-0000-0000-0000-${suffix}`,
            outcome: 'healed'
          })
        })
        writeSync(descriptor, `${lines.join('\n')}\n`)
      }
    } finally {
      closeSync(descriptor)
    }

    expect(() => collectPendingHealThreads(paths)).toThrow(CodexSessionIndexHealCapacityError)
  })

  it('rejects an oversized sparse completion marker', () => {
    const paths = makePaths()
    writeFileSync(
      paths.healMarkerPath,
      JSON.stringify({
        version: CODEX_SESSION_INDEX_HEAL_VERSION,
        systemSessionsRoot: paths.systemSessionsRoot,
        auditBytes: 0
      })
    )
    truncateSync(paths.healMarkerPath, MAX_CODEX_SESSION_INDEX_HEAL_MARKER_FILE_BYTES + 1)

    expect(isHealMarkerCurrent(paths, 0)).toBe(false)
  })
})
