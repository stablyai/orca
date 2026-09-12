import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../../shared/orcad-bun-runtime'
import { createWindowsBunPtyLaunch } from './windows-bun-pty-launch'

const runtimePath =
  process.env.BUN_EXECUTABLE ??
  resolve(__dirname, '../../../../out/orcad', orcadBunRuntimeFilename(process.platform))
const available = existsSync(runtimePath)

describe.skipIf(!available)('bundled Windows job gate under Bun', () => {
  it('executes the worker with real Bun flags and preserves long executable argv', async () => {
    expect(runProcessSync({ program: runtimePath, args: ['--version'] }).stdout.trim()).toBe(
      ORCAD_BUN_VERSION
    )
    const directory = mkdtempSync(join(tmpdir(), 'orca-gate-contract-'))
    const workerPath = join(directory, 'windows-bun-pty-gate-entry.js')
    try {
      await build({
        entryPoints: [join(__dirname, 'windows-bun-pty-gate-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: workerPath,
        logLevel: 'silent'
      })
      const argv = ['x'.repeat(16000), 'a b', 'quote"', '%value%&!', '状態', '']
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      const launch = createWindowsBunPtyLaunch(
        {
          file: runtimePath,
          args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...argv],
          cwd: directory,
          env
        },
        { runtimePath, workerPath }
      )
      try {
        launch.release()
        const result = await runProcess({
          program: launch.command[0]!,
          args: launch.command.slice(1),
          cwd: directory,
          env: launch.env,
          timeoutMs: 10_000
        })
        expect(result.timedOut).toBe(false)
        expect(result.code, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(argv)
        expect(existsSync(launch.command.at(-1)!)).toBe(false)
      } finally {
        launch.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
