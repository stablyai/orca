import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const sourcePath = join(
  projectRoot,
  'native',
  'playback-suppression-windows',
  'OrcaPlaybackSuppression.cs'
)
const hasMono =
  process.platform !== 'win32' &&
  spawnSync('mcs', ['--version']).status === 0 &&
  spawnSync('mono', ['--version']).status === 0
const itWithCompiler = process.platform === 'win32' || hasMono ? it : it.skip

describe('Windows playback suppression helper', () => {
  itWithCompiler(
    'emits a valid snapshot contract without audio hardware',
    { timeout: 15_000 },
    () => {
      const outputRoot = mkdtempSync(join(tmpdir(), 'orca playback suppression '))
      const helperPath = join(outputRoot, 'orca-playback-suppression.exe')
      try {
        const build =
          process.platform === 'win32'
            ? spawnSync(
                process.execPath,
                ['config/scripts/build-playback-suppression-windows.mjs', '--output', helperPath],
                { cwd: projectRoot, encoding: 'utf8' }
              )
            : spawnSync(
                'mcs',
                ['-langversion:5', '-warnaserror+', '-optimize+', `-out:${helperPath}`, sourcePath],
                { cwd: projectRoot, encoding: 'utf8' }
              )
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

        const run = spawnSync(
          process.platform === 'win32' ? helperPath : 'mono',
          process.platform === 'win32' ? ['self-test'] : [helperPath, 'self-test'],
          { cwd: projectRoot, encoding: 'utf8' }
        )

        expect(run.status, run.stderr).toBe(0)
        expect(JSON.parse(run.stdout)).toEqual({
          endpointId: 'orca-test-endpoint',
          endpointTarget: 'orca-test-endpoint',
          muted: false
        })
      } finally {
        rmSync(outputRoot, { recursive: true, force: true })
      }
    }
  )
})
