import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCodexCliInstallation } from './codex-cli-installation'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<object>()),
  runProcess
}))

function prints(stdout: string, timedOut = false): void {
  runProcess.mockResolvedValue({ code: 0, stdout, stderr: '', timedOut })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  runProcess.mockReset()
})

describe('Codex installation version probes', () => {
  it('probes every read and sees changes behind an unchanged launcher', async () => {
    const program = '/fake/codex'
    const input = { program, env: { PATH: '/launch/path' } }
    for (const version of ['0.135.0', '0.136.0', '0.135.0']) {
      prints(`company-wrapper 0.1.0\ncodex-cli ${version}`)
      expect((await readCodexCliInstallation(input)).version).toBe(version)
    }
    expect(runProcess).toHaveBeenCalledTimes(3)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program,
        env: input.env,
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      })
    )
  })

  it('allows a timeout and reads the next version without waiting', async () => {
    const program = '/fake/codex'
    prints('codex-cli 0.135.0', true)
    expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    prints('codex-cli 0.136.0')
    expect((await readCodexCliInstallation({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it.each(['ENOENT', 'EACCES'])(
    'leaves a failed version spawn (%s) to the existing chat failure',
    async (code) => {
      const program = '/fake/codex'
      runProcess.mockRejectedValue(Object.assign(new Error('unavailable'), { code }))
      expect((await readCodexCliInstallation({ program })).status).toBe('unknown')
    }
  )
})
