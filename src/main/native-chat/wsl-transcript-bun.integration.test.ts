import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'forks the built transcript companion under Bun and recovers after cancellation and child exit',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const directory = await mkdtemp(join(tmpdir(), 'orca-bun-transcript-'))
    try {
      const entry = join(directory, 'transcript-probe.cjs')
      await build({
        entryPoints: [join(__dirname, 'wsl-transcript-bun-fixture.ts')],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      await copyFile(
        join(
          process.cwd(),
          'out/relay',
          `${process.platform}-${process.arch}`,
          'wsl-transcript-fs-process-entry.js'
        ),
        join(directory, 'wsl-transcript-fs-process-entry.js')
      )
      const result = await runProcess({
        program: runtime,
        args: [entry],
        cwd: directory,
        env: {
          ORCA_BACKGROUND_LAUNCH: '1',
          NODE_OPTIONS: '',
          BUN_OPTIONS: '',
          NODE_REPL_EXTERNAL_MODULE: ''
        },
        timeoutMs: 15_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        'Bun transcript IPC, cancellation, replacement and disposal passed'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000
)
