import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'supervises serve readiness and graceful shutdown over real Bun-to-Node IPC',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-bun-serve-ipc-'))
    try {
      const fixture = join(root, 'fixture.cjs')
      await build({
        entryPoints: [join(__dirname, 'serve-bun-ipc-fixture.ts')],
        outfile: fixture,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      await build({
        entryPoints: [join(__dirname, '../../main/startup/serve-shutdown-child-fixture.ts')],
        outfile: join(root, 'shutdown-child.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      const result = await runProcess({
        program: runtime,
        args: [fixture, process.env.ORCA_SERVE_TEST_EXECUTABLE ?? process.execPath, root],
        env: { ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 15_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        'Bun supervisor verified real child IPC and durable readiness outcomes'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)
