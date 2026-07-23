import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_OMP_OVERLAY_MIGRATION_MAX_DEPTH,
  LEGACY_OMP_OVERLAY_MIGRATION_MAX_ENTRIES,
  LEGACY_OMP_OVERLAY_MIGRATION_MAX_PATH_BYTES,
  LEGACY_OMP_OVERLAY_MIGRATION_MAX_RETAINED_PATH_BYTES,
  migrateLegacyOmpOverlayState
} from './legacy-omp-overlay-migration'

const roots: string[] = []
const MARKER = '.orca-omp-overlay-migration-complete'

function tempPair(): { overlay: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-overlay-bounds-'))
  roots.push(root)
  const overlay = join(root, 'overlay')
  const source = join(root, 'source')
  mkdirSync(overlay)
  return { overlay, source }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy OMP overlay migration bounds', () => {
  it('publishes finite production traversal and retention limits', () => {
    expect(LEGACY_OMP_OVERLAY_MIGRATION_MAX_ENTRIES).toBe(100_000)
    expect(LEGACY_OMP_OVERLAY_MIGRATION_MAX_DEPTH).toBe(256)
    expect(LEGACY_OMP_OVERLAY_MIGRATION_MAX_PATH_BYTES).toBe(64 * 1_024)
    expect(LEGACY_OMP_OVERLAY_MIGRATION_MAX_RETAINED_PATH_BYTES).toBe(16 * 1_024 * 1_024)
  })

  it('marks a migration at the exact entry limit', () => {
    const { overlay, source } = tempPair()
    writeFileSync(join(overlay, 'one'), '1')
    writeFileSync(join(overlay, 'two'), '2')

    migrateLegacyOmpOverlayState(source, overlay, { maxEntries: 2 })

    expect(readFileSync(join(source, 'one'), 'utf8')).toBe('1')
    expect(readFileSync(join(source, 'two'), 'utf8')).toBe('2')
    expect(existsSync(join(overlay, MARKER))).toBe(true)
  })

  it('withholds the marker when the next streamed entry exceeds the limit', () => {
    const { overlay, source } = tempPair()
    writeFileSync(join(overlay, 'one'), '1')
    writeFileSync(join(overlay, 'two'), '2')
    writeFileSync(join(overlay, 'three'), '3')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    migrateLegacyOmpOverlayState(source, overlay, { maxEntries: 2 })

    expect(existsSync(join(overlay, MARKER))).toBe(false)
    expect(existsSync(join(source, 'one'))).toBe(false)
    expect(existsSync(join(source, 'two'))).toBe(false)
    expect(existsSync(join(source, 'three'))).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      '[pi-titlebar-extension] failed to migrate legacy OMP overlay state:',
      expect.objectContaining({ name: 'LegacyOverlayMigrationCapacityError' })
    )
  })

  it('accepts the exact path and retained-path byte boundaries', () => {
    const exact = tempPair()
    const exactOverlayPath = join(exact.overlay, 'state')
    const exactTargetPath = join(exact.source, 'state')
    writeFileSync(exactOverlayPath, 'state')
    const exactPathBytes = Math.max(
      Buffer.byteLength(exactOverlayPath, 'utf8'),
      Buffer.byteLength(exactTargetPath, 'utf8')
    )
    const exactRetainedBytes = Buffer.byteLength(exactTargetPath, 'utf8')

    migrateLegacyOmpOverlayState(exact.source, exact.overlay, {
      maxPathBytes: exactPathBytes,
      maxRetainedPathBytes: exactRetainedBytes
    })

    expect(readFileSync(exactTargetPath, 'utf8')).toBe('state')
    expect(existsSync(join(exact.overlay, MARKER))).toBe(true)

    const rejected = tempPair()
    const rejectedOverlayPath = join(rejected.overlay, 'state')
    const rejectedTargetPath = join(rejected.source, 'state')
    writeFileSync(rejectedOverlayPath, 'state')
    const retainedLimit = Buffer.byteLength(rejectedTargetPath, 'utf8') - 1

    migrateLegacyOmpOverlayState(rejected.source, rejected.overlay, {
      maxRetainedPathBytes: retainedLimit
    })

    expect(existsSync(rejectedTargetPath)).toBe(false)
    expect(existsSync(join(rejected.overlay, MARKER))).toBe(false)
  })

  it('accepts the exact path depth and rejects the next level', () => {
    const accepted = tempPair()
    mkdirSync(join(accepted.overlay, 'one', 'two'), { recursive: true })
    writeFileSync(join(accepted.overlay, 'one', 'two', 'leaf'), 'leaf')

    migrateLegacyOmpOverlayState(accepted.source, accepted.overlay, { maxDepth: 3 })

    expect(readFileSync(join(accepted.source, 'one', 'two', 'leaf'), 'utf8')).toBe('leaf')
    expect(existsSync(join(accepted.overlay, MARKER))).toBe(true)

    const rejected = tempPair()
    mkdirSync(join(rejected.overlay, 'one', 'two'), { recursive: true })
    writeFileSync(join(rejected.overlay, 'one', 'two', 'leaf'), 'leaf')

    migrateLegacyOmpOverlayState(rejected.source, rejected.overlay, { maxDepth: 2 })

    expect(existsSync(join(rejected.overlay, MARKER))).toBe(false)
  })
})
