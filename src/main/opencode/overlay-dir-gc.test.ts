import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP, sweepOrphanedOpenCodeDirs } from './overlay-dir-gc'

const DAY_MS = 24 * 60 * 60 * 1000
// Fixed "now" so age math never races the wall clock.
const NOW = 1_800_000_000_000

describe('sweepOrphanedOpenCodeDirs', () => {
  let workRoot: string
  let legacyHooksRoot: string
  let overlayRoot: string

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'orca-opencode-gc-'))
    legacyHooksRoot = join(workRoot, 'opencode-hooks')
    overlayRoot = join(workRoot, 'opencode-config-overlays')
    mkdirSync(legacyHooksRoot, { recursive: true })
    mkdirSync(overlayRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true })
  })

  function makeConfigDir(
    root: string,
    name: string,
    ageDays: number,
    opts?: { pluginAgeDays?: number }
  ): string {
    const dir = join(root, name)
    const pluginsDir = join(dir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginFile = join(pluginsDir, 'orca-opencode-status.js')
    const manifestFile = join(dir, '.orca-opencode-overlay-manifest.json')
    writeFileSync(pluginFile, '// plugin')
    writeFileSync(manifestFile, '{}')
    const at = (days: number) => new Date(NOW - days * DAY_MS)
    const pluginAt = at(opts?.pluginAgeDays ?? ageDays)
    // Files first, dirs last — utimes on a child does not touch the parent,
    // but creating children above refreshed the dir mtimes.
    utimesSync(pluginFile, pluginAt, pluginAt)
    utimesSync(manifestFile, at(ageDays), at(ageDays))
    utimesSync(pluginsDir, at(ageDays), at(ageDays))
    utimesSync(dir, at(ageDays), at(ageDays))
    return dir
  }

  function sweep(overrides?: Partial<Parameters<typeof sweepOrphanedOpenCodeDirs>[0]>) {
    return sweepOrphanedOpenCodeDirs({
      legacyHooksRoot,
      overlayRoot,
      referencedConfigDirs: new Set<string>(),
      now: NOW,
      ...overrides
    })
  }

  const hexName = (n: number) => n.toString(16).padStart(32, '0')

  it('removes old generated-name dirs under both roots and spares everything else', async () => {
    const legacyHex = makeConfigDir(legacyHooksRoot, hexName(1), 60)
    const legacyNumeric = makeConfigDir(legacyHooksRoot, '17', 60)
    const shared = makeConfigDir(legacyHooksRoot, 'shared', 60)
    const humanNamed = makeConfigDir(legacyHooksRoot, 'my-notes', 60)
    const shortHex = makeConfigDir(legacyHooksRoot, 'abcdef', 60)
    const overlayHex = makeConfigDir(overlayRoot, hexName(2), 60)
    // Numeric counter ids only ever existed under the legacy root; an
    // unexpected numeric name in the overlay root is not ours to delete.
    const overlayNumeric = makeConfigDir(overlayRoot, '17', 60)

    const result = await sweep()

    expect(existsSync(legacyHex)).toBe(false)
    expect(existsSync(legacyNumeric)).toBe(false)
    expect(existsSync(overlayHex)).toBe(false)
    expect(existsSync(shared)).toBe(true)
    expect(existsSync(humanNamed)).toBe(true)
    expect(existsSync(shortHex)).toBe(true)
    expect(existsSync(overlayNumeric)).toBe(true)
    expect(result.removed).toBe(3)
    expect(result.keptUnrecognized).toBe(4)
    expect(result.failed).toBe(0)
  })

  it('keeps an old dir referenced by a live session', async () => {
    const referenced = makeConfigDir(overlayRoot, hexName(3), 60)
    const orphan = makeConfigDir(overlayRoot, hexName(4), 60)

    const result = await sweep({ referencedConfigDirs: new Set([referenced]) })

    expect(existsSync(referenced)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(result.keptReferenced).toBe(1)
    expect(result.removed).toBe(1)
  })

  it('keeps a dir when a referenced path lives inside it', async () => {
    const parent = makeConfigDir(overlayRoot, hexName(5), 60)

    const result = await sweep({ referencedConfigDirs: new Set([join(parent, 'plugins')]) })

    expect(existsSync(parent)).toBe(true)
    expect(result.keptReferenced).toBe(1)
  })

  it('keeps orphans younger than the age gate', async () => {
    const young = makeConfigDir(overlayRoot, hexName(6), 5)

    const result = await sweep()

    expect(existsSync(young)).toBe(true)
    expect(result.keptYoung).toBe(1)
    expect(result.removed).toBe(0)
  })

  it('treats a freshly rewritten plugin file as recency even when dir mtimes are stale', async () => {
    // Why this matters: writeFileSync over an existing plugin file (the
    // per-spawn rewrite) updates only the file mtime, so the dir mtime of an
    // actively used config dir can be arbitrarily old.
    const active = makeConfigDir(overlayRoot, hexName(7), 60, { pluginAgeDays: 1 })

    const result = await sweep()

    expect(existsSync(active)).toBe(true)
    expect(result.keptYoung).toBe(1)
  })

  it('bounds removals per sweep and continues on a later sweep', async () => {
    const orphans = Array.from({ length: 7 }, (_, i) =>
      makeConfigDir(legacyHooksRoot, hexName(0x10 + i), 60)
    )

    const first = await sweep({ maxRemovals: 3 })
    expect(first.removed).toBe(3)
    expect(orphans.filter((dir) => existsSync(dir))).toHaveLength(4)

    const second = await sweep({ maxRemovals: 3 })
    expect(second.removed).toBe(3)
    expect(orphans.filter((dir) => existsSync(dir))).toHaveLength(1)

    const third = await sweep({ maxRemovals: 3 })
    expect(third.removed).toBe(1)
    expect(orphans.some((dir) => existsSync(dir))).toBe(false)
  })

  it('defaults the per-sweep bound to 500', () => {
    expect(OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP).toBe(500)
  })

  it('continues past a dir whose removal fails (EBUSY/EPERM)', async () => {
    const busy = makeConfigDir(legacyHooksRoot, hexName(0x20), 60)
    const others = [
      makeConfigDir(legacyHooksRoot, hexName(0x21), 60),
      makeConfigDir(legacyHooksRoot, hexName(0x22), 60)
    ]

    const result = await sweep({
      removeTree: (path) => {
        if (path === busy) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
        }
        safeRemoveTree(path)
      }
    })

    expect(existsSync(busy)).toBe(true)
    expect(others.some((dir) => existsSync(dir))).toBe(false)
    expect(result.failed).toBe(1)
    expect(result.removed).toBe(2)
  })

  it('is a no-op when the roots do not exist', async () => {
    const result = await sweepOrphanedOpenCodeDirs({
      legacyHooksRoot: join(workRoot, 'missing-a'),
      overlayRoot: join(workRoot, 'missing-b'),
      referencedConfigDirs: new Set<string>(),
      now: NOW
    })

    expect(result).toEqual({
      scanned: 0,
      removed: 0,
      keptReferenced: 0,
      keptYoung: 0,
      keptUnrecognized: 0,
      failed: 0
    })
  })

  it.runIf(process.platform !== 'win32')(
    'never follows a symlinked entry even with a generated name',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'orca-opencode-gc-outside-'))
      try {
        writeFileSync(join(outside, 'user-data.txt'), 'precious')
        const linkPath = join(legacyHooksRoot, hexName(0x30))
        symlinkSync(outside, linkPath, 'dir')

        const result = await sweep()

        expect(existsSync(join(outside, 'user-data.txt'))).toBe(true)
        expect(existsSync(linkPath)).toBe(true)
        expect(result.keptUnrecognized).toBe(1)
        expect(result.removed).toBe(0)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    }
  )
})
