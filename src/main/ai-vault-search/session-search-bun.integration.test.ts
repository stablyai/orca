import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'indexes and searches a transcript with the pinned Bun SQLite driver',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const directory = await mkdtemp(join(tmpdir(), 'orca-bun-search-'))
    try {
      const entry = join(directory, 'search-probe.cjs')
      await build({
        entryPoints: [join(__dirname, 'session-search-bun-fixture.ts')],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024',
        external: ['electron', 'bun:sqlite']
      })
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
      expect(result.stdout).toContain('Bun search registration, indexing, query and consent passed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000
)
