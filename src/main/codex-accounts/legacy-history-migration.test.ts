import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_LEGACY_HISTORY_READ_CHUNK_BYTES,
  mergeCodexLegacyHistorySync
} from './legacy-history-migration'

describe('Codex legacy history migration', () => {
  let root = ''
  let legacyHistoryPath = ''
  let runtimeHistoryPath = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-legacy-history-'))
    legacyHistoryPath = join(root, 'legacy-history.jsonl')
    runtimeHistoryPath = join(root, 'runtime-history.jsonl')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('preserves the legacy merge order and exact normalized output in limit', () => {
    const longLegacyLine = `🦀${'x'.repeat(CODEX_LEGACY_HISTORY_READ_CHUNK_BYTES + 8)}`
    writeFileSync(runtimeHistoryPath, 'first\n\nsecond\r\nlast')
    writeFileSync(legacyHistoryPath, `second\r\nthird\nfirst\n\nthird\n${longLegacyLine}`)

    const result = mergeCodexLegacyHistorySync({ legacyHistoryPath, runtimeHistoryPath })

    expect(result).toMatchObject({ kind: 'merged', addedLineCount: 2, outputLineCount: 5 })
    expect(readFileSync(runtimeHistoryPath, 'utf8')).toBe(
      `first\nsecond\r\nlast\nthird\n${longLegacyLine}\n`
    )
  })

  it('leaves the runtime file byte-for-byte unchanged when output exceeds its limit', () => {
    const originalRuntime = 'runtime\n'
    writeFileSync(runtimeHistoryPath, originalRuntime)
    writeFileSync(legacyHistoryPath, 'new-value\n')

    const result = mergeCodexLegacyHistorySync({
      legacyHistoryPath,
      runtimeHistoryPath,
      limits: { maxOutputBytes: Buffer.byteLength(originalRuntime) }
    })

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'output-bytes',
      observed: Buffer.byteLength(originalRuntime) + Buffer.byteLength('new-value\n'),
      limit: Buffer.byteLength(originalRuntime)
    })
    expect(readFileSync(runtimeHistoryPath, 'utf8')).toBe(originalRuntime)
  })

  it('does not create partial output for an oversized source file or line', () => {
    writeFileSync(legacyHistoryPath, '')
    truncateSync(legacyHistoryPath, 4096)

    const fileResult = mergeCodexLegacyHistorySync({
      legacyHistoryPath,
      runtimeHistoryPath,
      limits: { maxFileBytes: 1024 }
    })

    expect(fileResult).toMatchObject({ kind: 'skipped', reason: 'file-bytes', limit: 1024 })
    expect(existsSync(runtimeHistoryPath)).toBe(false)

    writeFileSync(legacyHistoryPath, 'oversized\n')
    const lineResult = mergeCodexLegacyHistorySync({
      legacyHistoryPath,
      runtimeHistoryPath,
      limits: { maxLineBytes: 4 }
    })

    expect(lineResult).toMatchObject({ kind: 'skipped', reason: 'line-bytes', limit: 4 })
    expect(existsSync(runtimeHistoryPath)).toBe(false)
  })

  it('bounds input records even when every record is empty or duplicated', () => {
    writeFileSync(legacyHistoryPath, 'same\nsame\n\nsame\n')

    const result = mergeCodexLegacyHistorySync({
      legacyHistoryPath,
      runtimeHistoryPath,
      limits: { maxInputLines: 3 }
    })

    expect(result).toMatchObject({
      kind: 'skipped',
      reason: 'input-lines',
      observed: 4,
      limit: 3
    })
    expect(existsSync(runtimeHistoryPath)).toBe(false)
  })

  it('leaves an existing empty-only runtime file untouched when no record survives', () => {
    writeFileSync(runtimeHistoryPath, '\n\n')
    writeFileSync(legacyHistoryPath, '\n')

    expect(mergeCodexLegacyHistorySync({ legacyHistoryPath, runtimeHistoryPath })).toEqual({
      kind: 'empty'
    })
    expect(readFileSync(runtimeHistoryPath, 'utf8')).toBe('\n\n')
  })
})
