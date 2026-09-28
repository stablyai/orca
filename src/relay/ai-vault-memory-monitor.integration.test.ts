import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE

describe.skipIf(!runtime)('Bun Vault resident memory monitor', () => {
  let directory: string
  let entry: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-bun-memory-'))
    entry = join(directory, 'probe.cjs')
    await build({
      entryPoints: [join(__dirname, 'ai-vault-memory-monitor-fixture.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'es2024'
    })
  })

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function run(mode: string) {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    return runProcess({
      program: runtime,
      args: [entry, mode],
      cwd: directory,
      env: { ORCA_BACKGROUND_LAUNCH: '1', NODE_OPTIONS: '', BUN_OPTIONS: '' },
      timeoutMs: 10_000
    })
  }

  it('terminates excessive allocations even when the main thread is busy', async () => {
    const result = await run('allocate')
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('exceeded its resident memory budget')
    expect(result.stdout).not.toContain('allocation survived')
  })

  it('does not keep an otherwise idle service alive', async () => {
    const result = await run('idle')
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('monitor does not retain the service')
  })

  it('fails the service when its monitor stops unexpectedly', async () => {
    const result = await run('failed-monitor')
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('memory monitor stopped unexpectedly')
    expect(result.stderr).not.toContain('Service survived')
  })
})
