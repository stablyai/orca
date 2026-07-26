import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_LEGACY_SESSION_COMPARE_CHUNK_BYTES,
  codexLegacySessionFilesEqualSync,
  migrateCodexLegacySessionsSync
} from './legacy-session-migration'

describe('Codex legacy session migration', () => {
  let root = ''
  let legacySessionsRoot = ''
  let runtimeSessionsRoot = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-legacy-sessions-'))
    legacySessionsRoot = join(root, 'legacy')
    runtimeSessionsRoot = join(root, 'runtime')
    mkdirSync(legacySessionsRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('preserves creation of the runtime sessions directory for an empty legacy tree', () => {
    const result = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot
    })

    expect(result).toMatchObject({
      kind: 'migrated',
      copiedFileCount: 0,
      discoveredEntryCount: 0,
      discoveredFileCount: 0
    })
    expect(existsSync(runtimeSessionsRoot)).toBe(true)
  })

  it('copies and conflict-preserves ordinary files in the historical sorted order', () => {
    mkdirSync(join(legacySessionsRoot, 'nested'))
    mkdirSync(join(runtimeSessionsRoot, 'nested'), { recursive: true })
    writeFileSync(join(legacySessionsRoot, 'z-copy.jsonl'), 'copy\n')
    writeFileSync(join(legacySessionsRoot, 'a-conflict.jsonl'), 'legacy\n')
    writeFileSync(join(runtimeSessionsRoot, 'a-conflict.jsonl'), 'runtime\n')
    writeFileSync(join(legacySessionsRoot, 'nested', 'same.jsonl'), 'same\n')
    writeFileSync(join(runtimeSessionsRoot, 'nested', 'same.jsonl'), 'same\n')
    const conflicts: string[] = []

    const result = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot,
      onConflict: ({ runtimeFilePath }) => conflicts.push(runtimeFilePath)
    })

    expect(result).toMatchObject({
      kind: 'migrated',
      conflictCount: 1,
      copiedFileCount: 2,
      discoveredEntryCount: 4,
      discoveredFileCount: 3
    })
    expect(conflicts).toEqual([join(runtimeSessionsRoot, 'a-conflict.jsonl')])
    expect(readFileSync(join(runtimeSessionsRoot, 'z-copy.jsonl'), 'utf8')).toBe('copy\n')
    expect(
      readFileSync(join(runtimeSessionsRoot, 'a-conflict.orca-legacy-account-1.jsonl'), 'utf8')
    ).toBe('legacy\n')
    expect(readFileSync(join(runtimeSessionsRoot, 'a-conflict.jsonl'), 'utf8')).toBe('runtime\n')
  })

  it('compares sparse multi-megabyte collisions with fixed-size buffers', () => {
    mkdirSync(runtimeSessionsRoot)
    const legacyPath = join(legacySessionsRoot, 'large.jsonl')
    const runtimePath = join(runtimeSessionsRoot, 'large.jsonl')
    const sparseBytes = CODEX_LEGACY_SESSION_COMPARE_CHUNK_BYTES * 128
    for (const path of [legacyPath, runtimePath]) {
      writeFileSync(path, 'same-prefix')
      truncateSync(path, sparseBytes)
    }

    expect(codexLegacySessionFilesEqualSync(legacyPath, runtimePath)).toBe(true)
    const result = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot
    })

    expect(result).toMatchObject({ kind: 'migrated', conflictCount: 0, copiedFileCount: 0 })
    expect(existsSync(join(runtimeSessionsRoot, 'large.orca-legacy-account-1.jsonl'))).toBe(false)
  })

  it('preflights the entry cap before copying any file', () => {
    writeFileSync(join(legacySessionsRoot, 'a.jsonl'), 'a')
    writeFileSync(join(legacySessionsRoot, 'b.jsonl'), 'b')

    const result = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot,
      limits: { maxEntries: 1 }
    })

    expect(result).toMatchObject({
      kind: 'skipped',
      reason: 'entries',
      observed: 2,
      limit: 1
    })
    expect(existsSync(runtimeSessionsRoot)).toBe(false)
  })

  it('preflights depth and aggregate file bytes before copying', () => {
    mkdirSync(join(legacySessionsRoot, 'one', 'two'), { recursive: true })
    writeFileSync(join(legacySessionsRoot, 'one', 'two', 'deep.jsonl'), 'deep')

    const depthResult = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot,
      limits: { maxDepth: 1 }
    })

    expect(depthResult).toMatchObject({ kind: 'skipped', reason: 'depth', observed: 2, limit: 1 })
    expect(existsSync(runtimeSessionsRoot)).toBe(false)

    rmSync(join(legacySessionsRoot, 'one'), { recursive: true })
    writeFileSync(join(legacySessionsRoot, 'a.jsonl'), '1234')
    writeFileSync(join(legacySessionsRoot, 'b.jsonl'), '5678')
    const byteResult = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot,
      limits: { maxTotalFileBytes: 7 }
    })

    expect(byteResult).toMatchObject({
      kind: 'skipped',
      reason: 'total-file-bytes',
      observed: 8,
      limit: 7
    })
    expect(existsSync(runtimeSessionsRoot)).toBe(false)
  })

  it('bounds retained path text independently of entry count', () => {
    writeFileSync(join(legacySessionsRoot, 'long-name.jsonl'), 'content')

    const result = migrateCodexLegacySessionsSync({
      accountId: 'account-1',
      legacySessionsRoot,
      runtimeSessionsRoot,
      limits: { maxPathCodeUnits: legacySessionsRoot.length }
    })

    expect(result).toMatchObject({
      kind: 'skipped',
      reason: 'path-code-units',
      limit: legacySessionsRoot.length
    })
    expect(existsSync(runtimeSessionsRoot)).toBe(false)
  })
})
