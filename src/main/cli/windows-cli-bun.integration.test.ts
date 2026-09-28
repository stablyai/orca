import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(process.platform !== 'win32' || !runtime)(
  'runs the native packaged CLI launcher with real Bun',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const directory = await mkdtemp(join(tmpdir(), 'orca-windows-cli-bun-'))
    try {
      const entry = join(directory, 'windows-cli-probe.cjs')
      await build({
        entryPoints: [join(__dirname, 'windows-cli-bun-fixture.ts')],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      await build({
        entryPoints: [join(process.cwd(), 'src/cli/runtime/windows-cli-owner-fixture.ts')],
        outfile: join(directory, 'owner-entry.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      for (const [entry, output] of [
        ['src/cli/runtime/serve-bun-ipc-fixture.ts', 'serve-owner-entry.cjs'],
        ['src/main/startup/serve-shutdown-child-fixture.ts', 'shutdown-child.cjs']
      ]) {
        await build({
          entryPoints: [join(process.cwd(), entry)],
          outfile: join(directory, output),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'es2024'
        })
      }
      await copyFile(
        join(process.cwd(), 'native/windows-cli-launcher/OrcaCliLauncher.cs'),
        join(directory, 'OrcaCliLauncher.cs')
      )
      const result = await runProcess({
        program: runtime,
        args: [entry],
        cwd: directory,
        env: {
          ORCA_BACKGROUND_LAUNCH: '1',
          BUN_OPTIONS: '',
          NODE_OPTIONS: '',
          ORCA_SERVE_TEST_EXECUTABLE: process.execPath
        },
        timeoutMs: 60_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        'Windows native Bun launcher argv, environment, exit and missing-runtime checks passed'
      )
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  70_000
)
