import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const itMac = process.platform === 'darwin' ? it : it.skip
const projectRoot = resolve(import.meta.dirname, '../..')

describe('macOS playback suppression helper', () => {
  itMac('builds and passes its hardware-independent contract check', { timeout: 30_000 }, () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca playback suppression '))
    try {
      const result = spawnSync(
        process.execPath,
        [
          'config/scripts/build-playback-suppression-macos.mjs',
          '--single-arch',
          '--output',
          join(outputRoot, 'orca-playback-suppression')
        ],
        { cwd: projectRoot, encoding: 'utf8' }
      )

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
