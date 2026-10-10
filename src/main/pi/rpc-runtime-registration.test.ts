import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { PI_RPC_RUNTIME_REGISTRATION } from './rpc-runtime-registration'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

type LaunchInput = Parameters<NonNullable<typeof PI_RPC_RUNTIME_REGISTRATION.supportsLaunch>>[0]
function supportsLaunch(launch: LaunchInput): Promise<boolean> {
  const check = PI_RPC_RUNTIME_REGISTRATION.supportsLaunch
  if (!check) {
    throw new Error('Pi registers a launch check')
  }
  return check(launch)
}
let root: string
let stockPi: string

function prints(stdout: string, result: Partial<Awaited<ReturnType<typeof runProcess>>> = {}) {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    ...result
  })
}

beforeEach(async () => {
  vi.mocked(runProcess).mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  root = await mkdtemp(join(tmpdir(), 'orca-pi-support-'))
  stockPi = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
  await writeFile(stockPi, '')
  await chmod(stockPi, 0o755)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const input = (commandSettings: LaunchInput['commandSettings'] = {}): LaunchInput => ({
  cwd: '/host/workspace',
  env: { PATH: root, HOME: '/host/home' },
  commandSettings
})

describe('Pi launch support before session creation', () => {
  it.each(['0.84.0', '0.99.0', '1.0.0', '1.0.4\n', 'pi v1.12.3'])(
    'accepts stable Pi from 0.84.0: %s',
    async (out) => {
      prints(out)
      await expect(supportsLaunch(input())).resolves.toBe(true)
      expect(runProcess).toHaveBeenCalledWith({
        program: stockPi,
        cwd: '/host/workspace',
        env: { PATH: root, HOME: '/host/home' },
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        killOnOutputLimit: true
      })
    }
  )

  it.each([
    '0.73.1',
    '0.83.9',
    '0.84.0-rc.1',
    '1.0.0-rc.1',
    '1.1.0-preview.1',
    '2.0.0',
    'unknown',
    ''
  ])('keeps the terminal chat for an older, prerelease or unknown version: %s', async (out) => {
    prints(out)
    await expect(supportsLaunch(input())).resolves.toBe(false)
  })

  it.each([
    { code: 1, timedOut: false, outputTruncated: false },
    { code: 0, timedOut: true, outputTruncated: false },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('does not infer support from incomplete or failed output: %j', async (result) => {
    prints('1.0.4', result)
    await expect(supportsLaunch(input())).resolves.toBe(false)
  })

  it('probes the binary the Command setting names, not the stock one', async () => {
    prints('1.0.4')
    await expect(
      supportsLaunch(input({ agentCmdOverrides: { pi: `"${process.execPath}"` } }))
    ).resolves.toBe(true)
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ program: process.execPath }))
  })

  it('leaves an unrunnable Command setting to the launch to refuse', async () => {
    await expect(supportsLaunch(input({ agentCmdOverrides: { pi: '/missing/pi' } }))).resolves.toBe(
      true
    )
    expect(runProcess).not.toHaveBeenCalled()
  })
})
