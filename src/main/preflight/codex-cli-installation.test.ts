import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_MINIMUM_SUPPORTED_VERSION } from '../../shared/codex-cli-installation'
import { checkAgentCliVersion } from '../agent-cli-version-probe'
import { readCodexCliVersion } from '../codex/codex-cli-installation-error'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<object>()),
  runProcess
}))

const checkCodex = (input: Parameters<typeof readCodexCliVersion>[0]) =>
  checkAgentCliVersion(input, [CODEX_MINIMUM_SUPPORTED_VERSION], readCodexCliVersion)

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
      expect((await readCodexCliVersion(input)).version).toBe(version)
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
    expect((await checkCodex({ program })).status).toBe('unknown')
    prints('codex-cli 0.136.0')
    expect((await checkCodex({ program })).status).toBe('ready')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it.each(['ENOENT', 'EACCES'])(
    'leaves a failed version spawn (%s) to the existing chat failure',
    async (code) => {
      const program = '/fake/codex'
      runProcess.mockRejectedValue(Object.assign(new Error('unavailable'), { code }))
      expect((await checkCodex({ program })).status).toBe('missing')
    }
  )
})
