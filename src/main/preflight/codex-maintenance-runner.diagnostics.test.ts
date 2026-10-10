import { afterEach, expect, it, vi } from 'vitest'
import { setTimeout as scheduleTimeout } from 'node:timers'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { CodexMaintenanceRunner } from './codex-maintenance-runner'
import { codexMaintenanceDiagnostic } from './codex-maintenance-diagnostic'

vi.mock('./codex-maintenance-command', () => ({ resolveCodexMaintenanceCommand: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

function fixture(
  script = "process.stderr.write('npm ERR! EACCES: permission denied\\n'); process.exit(17)"
) {
  const resolve = vi.fn().mockResolvedValue({
    installation: codexCliInstallation(false, null),
    spec: { program: process.execPath, args: ['-e', script] }
  })
  const spawn = vi.fn<PipedProcessSpawner>(spawnProcess)
  const runner = new CodexMaintenanceRunner({ resolve, spawn, invalidate: vi.fn() })
  return { runner, spawn }
}

async function finished(runner: CodexMaintenanceRunner, id?: string) {
  await vi.waitFor(async () => expect((await runner.status(id)).job?.phase).toBe('completed'), {
    timeout: 15_000
  })
  const job = (await runner.status(id)).job
  if (!job) {
    throw new Error('Missing job')
  }
  return job
}

it('appends a spawn error with no stderr to the host log and permits another explicit attempt', async () => {
  const { runner, spawn } = fixture()
  spawn.mockImplementation(() => {
    throw new Error('spawn C:\\tools\\node.exe EACCES')
  })
  const first = await runner.start()
  const job = await finished(runner, first.job?.id)
  expect(job.output).toBe('$ npm install -g @openai/codex\n\nspawn C:\\tools\\node.exe EACCES\n')
  expect(job.error).toBe('spawn C:\\tools\\node.exe EACCES')
  expect(job.exitCode).toBeNull()
  const retry = await runner.start()
  expect(retry.job?.id).not.toBe(job.id)
  await finished(runner, retry.job?.id)
})

it.skipIf(process.platform === 'win32')(
  'appends a timeout with no stderr after the owned process stops',
  async () => {
    const { runner } = fixture("console.log('ready'); setTimeout(()=>process.exit(99),30000)")
    let timeout: () => void = () => {
      throw new Error('No maintenance timeout')
    }
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 10 * 60_000) {
          timeout = () => callback(...args)
        }
        return scheduleTimeout(callback, delay, ...args)
      })
    const first = await runner.start()
    try {
      await vi.waitFor(
        async () => expect((await runner.status(first.job?.id)).job?.output).toContain('ready'),
        {
          timeout: 15_000
        }
      )
    } finally {
      timer.mockRestore()
      timeout()
      await finished(runner, first.job?.id)
    }
    const job = await finished(runner, first.job?.id)
    expect(job.output).toContain('\nCodex maintenance timed out.\n')
    expect(job.error).toBe('Codex maintenance timed out.')
    expect(job.termination).toBe('exited')
  },
  25_000
)

it('retains ordinary npm stderr without adding a duplicate diagnostic', async () => {
  const { runner } = fixture()
  const first = await runner.start()
  const job = await finished(runner, first.job?.id)
  expect(job.output).toBe('$ npm install -g @openai/codex\nnpm ERR! EACCES: permission denied\n')
  expect(job.exitCode).toBe(17)
  expect(job.error).toBeNull()
})

it('bounds and sanitizes appended errors while preserving useful error codes', async () => {
  const { runner, spawn } = fixture()
  const raw = `\u001b[31mEACCES\u001b[0m\r\nhttps://user:secret@example.test token=private\u0000 ${'x'.repeat(2000)}`
  spawn.mockImplementation(() => {
    throw new Error(raw)
  })
  const first = await runner.start()
  const job = await finished(runner, first.job?.id)
  const diagnostic = codexMaintenanceDiagnostic(raw)
  expect(diagnostic).toHaveLength(1024)
  expect(diagnostic).toMatch(/^EACCES https:\/\/example.test token=\[redacted\] /)
  expect(diagnostic).not.toMatch(/secret|private/)
  for (const control of ['\u001b', '\u0000', '\r', '\n']) {
    expect(diagnostic).not.toContain(control)
  }
  expect(job.output).toContain(`\n${diagnostic}\n`)
})
