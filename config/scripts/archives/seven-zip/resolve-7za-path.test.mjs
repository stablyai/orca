import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolve7zaPath } from './resolve-7za-path.mjs'

const projectRoot = resolve(import.meta.dirname, '../../../..')

describe('7za path resolution for the Windows signing gates (#6487)', () => {
  // Use directory override: Test-Path accepts it, masking bad resolver validation until extraction fails.
  it('ignores an override that points at a directory', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca 7za dir override '))
    const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH
    try {
      process.env.ELECTRON_BUILDER_7ZIP_PATH = scratch
      const resolved = await resolve7zaPath(projectRoot)
      expect(resolved).not.toBe(scratch)
      expect(statSync(resolved).isFile()).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_BUILDER_7ZIP_PATH
      } else {
        process.env.ELECTRON_BUILDER_7ZIP_PATH = previous
      }
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  // Use fresh subprocess: app-builder-lib memoizes toolset, hiding dangling-override failures in warm process.
  it('ignores an override that points at a missing file, in a cold process', () => {
    const dangling = join(tmpdir(), 'orca-7za-does-not-exist')
    const result = spawnSync(
      process.execPath,
      ['config/scripts/archives/seven-zip/resolve-7za-path.mjs'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_BUILDER_7ZIP_PATH: dangling },
        timeout: 120_000
      }
    )

    expect(result.stderr ?? '').not.toContain('does not exist')
    expect(result.status).toBe(0)
    const resolved = result.stdout.trim()
    expect(resolved).not.toBe(dangling)
    expect(existsSync(resolved)).toBe(true)
  }, 120_000)
})
