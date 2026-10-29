import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

it.each(['ordinary', 'cached-qualification', 'failed-startup'])(
  'owns a real filesystem authority in a fresh %s serving lifetime',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-serving-filesystem-'))
    const require = createRequire(import.meta.url)
    try {
      for (const [name, source] of [
        ['filesystem-host-entry.js', join(__dirname, '../filesystem-host/filesystem-host-entry.ts')],
        ['worker-thread-child-process-entry.js', join(__dirname, '../worker-thread-child-process/worker-thread-child-process-entry.ts')]
      ]) {
        await writeFile(join(directory, name), `require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(source)});`)
      }
      const result = await runProcess({
        program: process.execPath,
        args: ['--conditions=orca-source', join(__dirname, '__fixtures__/orcad-filesystem-lifetime.cjs'), directory, mode],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_USER_DATA: directory },
        timeoutMs: 15000,
        terminationBarrier: true
      })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout).toContain('filesystem serving lifetime passed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20000
)
