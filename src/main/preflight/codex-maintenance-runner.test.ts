import { describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import type { PipedProcessSpawner, ProcessSpec } from '@orca/process-host/process-spec'
import { CodexMaintenanceRunner } from './codex-maintenance-runner'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./codex-maintenance-command', () => ({ resolveCodexMaintenanceCommand: vi.fn() }))

function fixture(exitCode = 0, releasePath?: string) {
  const installation = codexCliInstallation(false, null)
  const ready = codexCliInstallation(true, '0.136.0')
  const spec: ProcessSpec = {
    program: process.execPath,
    args: [
      '-e',
      releasePath
        ? `const fs=require('node:fs'); process.stdout.write('first chunk\\n'); const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])) {clearInterval(timer); process.stderr.write('last chunk\\n'); process.exit(${exitCode})}},50); setTimeout(()=>process.exit(99),20000)`
        : `process.stdout.write('first chunk\\n'); setTimeout(() => { process.stderr.write('last chunk\\n'); process.exit(${exitCode}) }, 100)`,
      ...(releasePath ? [releasePath] : [])
    ]
  }
  const evidence = { expiresAt: Date.now() + 30_000, configurationId: 'configuration' }
  const resolve = vi.fn().mockResolvedValue({ installation, evidence, spec })
  const spawn = vi.fn<PipedProcessSpawner>(spawnProcess)
  const invalidate = vi.fn(() => {
    resolve.mockResolvedValue({
      installation: exitCode ? installation : ready,
      evidence,
      spec: exitCode ? spec : null
    })
  })
  const runner = new CodexMaintenanceRunner({ resolve, spawn, invalidate })
  return { runner, resolve, spawn, invalidate }
}

async function finished(runner: CodexMaintenanceRunner, id: string) {
  await vi.waitFor(
    async () => {
      expect((await runner.status(id)).job?.phase).toBe('completed')
    },
    { timeout: 15_000 }
  )
  return runner.status(id)
}

describe('host-owned Codex maintenance runner', () => {
  it('starts one job for simultaneous calls and keeps the lock until the child exits', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.runner.start(), f.runner.start()])
    expect(first.job?.id).toBe(second.job?.id)
    expect((await f.runner.start()).job?.id).toBe(first.job?.id)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    if (!first.job) {
      throw new Error('No job')
    }
    await finished(f.runner, first.job.id)
  })

  it('streams stdout and stderr while running, then invalidates and checks installation on exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-maintenance-stream-'))
    const releasePath = join(directory, 'release')
    const f = fixture(0, releasePath)
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const id = state.job.id
    try {
      await vi.waitFor(
        async () => {
          const current = await f.runner.status(id)
          expect(current.job?.output).toContain('first chunk')
          expect(current.job?.phase).toBe('running')
        },
        { timeout: 15_000 }
      )
    } finally {
      await writeFile(releasePath, 'release')
      await finished(f.runner, id)
      await rm(directory, { recursive: true, force: true })
    }
    const result = await f.runner.status(id)
    expect(result.job?.output).toContain('last chunk')
    expect(result.job?.exitCode).toBe(0)
    expect(result.installation.status).toBe('ready')
    expect(result.canRun).toBe(false)
    expect(f.invalidate).toHaveBeenCalledTimes(1)
    expect(f.resolve.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      f.invalidate.mock.invocationCallOrder[0]
    )
  }, 25_000)

  it('keeps the failure exit code and log, rechecks, and permits an explicit retry', async () => {
    const f = fixture(17)
    const first = await f.runner.start()
    if (!first.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, first.job.id)
    expect(result.job?.exitCode).toBe(17)
    expect(result.job?.output).toContain('last chunk')
    expect(result.installation.status).toBe('missing')
    const retry = await f.runner.start()
    expect(retry.job?.id).not.toBe(first.job.id)
    if (!retry.job) {
      throw new Error('No retry')
    }
    await finished(f.runner, retry.job.id)
  })

  it('records a spawn failure and releases the job after rechecking', async () => {
    const f = fixture()
    f.spawn.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, state.job.id)
    expect(result.job?.error).toBe('permission denied')
    expect(f.invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not run anything from a status read or for a supported installation', async () => {
    const f = fixture()
    await f.runner.status()
    expect(f.spawn).not.toHaveBeenCalled()
    f.resolve.mockResolvedValue({ installation: codexCliInstallation(true, '0.136.0'), spec: null })
    await expect(f.runner.start()).rejects.toThrow('does not need')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('keeps the verified result when a status read started before the install finishes late', async () => {
    const f = fixture()
    let completeStatus: (value: unknown) => void = () => {}
    f.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeStatus = resolve
        })
    )
    const pending = f.runner.status()
    const started = await f.runner.start()
    if (!started.job) {
      throw new Error('No job')
    }
    await finished(f.runner, started.job.id)
    completeStatus({ installation: codexCliInstallation(false, null), spec: null })
    expect((await pending).installation.status).toBe('ready')
  })

  it('bounds streamed output while retaining final diagnostics', async () => {
    const f = fixture()
    f.resolve.mockResolvedValue({
      installation: codexCliInstallation(false, null),
      spec: {
        program: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(200000) + 'final diagnostic')"]
      }
    })
    const state = await f.runner.start()
    if (!state.job) {
      throw new Error('No job')
    }
    const result = await finished(f.runner, state.job.id)
    expect(Buffer.byteLength(result.job?.output ?? '')).toBeLessThanOrEqual(128 * 1024)
    expect(result.job?.output).toContain('final diagnostic')
  })

  it.each(['é', '用', '😀'])(
    'drops a partial %s at the retained tail boundary',
    async (character) => {
      const f = fixture()
      const tail = 'y'.repeat(128 * 1024 - 1)
      f.resolve.mockResolvedValue({
        installation: codexCliInstallation(false, null),
        spec: {
          program: process.execPath,
          args: ['-e', `process.stdout.write('prefix${character}' + 'y'.repeat(128 * 1024 - 1))`]
        }
      })
      const state = await f.runner.start()
      if (!state.job) {
        throw new Error('No job')
      }
      const result = await finished(f.runner, state.job.id)
      expect(Buffer.byteLength(result.job?.output ?? '')).toBe(128 * 1024 - 1)
      expect(result.job?.output).toBe(tail)
    }
  )

  it('separates a historical log read from the latest job and forwards the host evidence unchanged', async () => {
    const f = fixture(1)
    const first = await f.runner.start()
    if (!first.job) {
      throw new Error('No first job')
    }
    await finished(f.runner, first.job.id)
    const second = await f.runner.start()
    if (!second.job) {
      throw new Error('No second job')
    }
    await finished(f.runner, second.job.id)
    const historical = await f.runner.status(first.job.id)
    expect(historical.job?.id).toBe(first.job.id)
    expect(historical.currentJob?.id).toBe(second.job.id)
    expect(historical.evidence).toEqual(first.evidence)
  })
})
