import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(process.platform !== 'win32' || !runtime)(
  'reads real Bun PTY console membership without the node-pty package',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const directory = await mkdtemp(join(tmpdir(), 'orca-bun-console-'))
    try {
      const entry = join(directory, 'console-probe.cjs')
      const entries = [
        [join(__dirname, 'windows-bun-console-fixture.ts'), entry],
        [
          join(__dirname, '../daemon/pty-subprocess/windows-bun-pty-gate-entry.ts'),
          join(directory, 'windows-bun-pty-gate-entry.js')
        ]
      ] as const
      for (const [input, output] of entries) {
        await build({
          entryPoints: [input],
          outfile: output,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'es2024',
          external: ['bun:ffi', 'node-pty']
        })
      }
      const result = await runProcess({
        program: runtime,
        args: [entry],
        cwd: directory,
        env: { ORCA_BACKGROUND_LAUNCH: '1', BUN_OPTIONS: '', NODE_OPTIONS: '', NODE_PATH: '' },
        timeoutMs: 20_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        first: expect.any(Array),
        running: expect.any(Array)
      })
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  30_000
)
