import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({
  resolveCliCommandAsync: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('../../../shared/shell/command-resolution/node-cli-command-async-resolution', () => ({
  resolveCliCommandAsync: mocks.resolveCliCommandAsync
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))

import {
  isExternalAutomationCommandOnPath,
  runLocalAutomationCommand
} from './external-manager-local-command'

const OPENCLAW_CMD = 'C:\\Users\\ada\\AppData\\Roaming\\npm\\openclaw.cmd'

function exited(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

beforeEach(() => {
  mocks.resolveCliCommandAsync.mockReset()
  mocks.runProcess.mockReset()
})

describe('isExternalAutomationCommandOnPath', () => {
  it('is available only when resolution changes the command', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(true)
    expect(mocks.resolveCliCommandAsync).toHaveBeenCalledWith('openclaw')

    mocks.resolveCliCommandAsync.mockResolvedValue('openclaw')
    await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(false)
  })

  it('runs no lookup subprocess', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    await isExternalAutomationCommandOnPath('openclaw')
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('is unavailable when resolution throws', async () => {
    mocks.resolveCliCommandAsync.mockRejectedValue(new Error('EPERM'))
    await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(false)
  })
})

describe('runLocalAutomationCommand', () => {
  it('spawns the resolved shim path instead of the bare name', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    mocks.runProcess.mockResolvedValue(exited())

    await runLocalAutomationCommand('openclaw', ['cron', 'list'])

    expect(mocks.runProcess).toHaveBeenCalledWith({
      program: OPENCLAW_CMD,
      args: ['cron', 'list'],
      timeoutMs: 30_000
    })
    expect(mocks.runProcess.mock.calls[0]?.[0].program).not.toBe('openclaw')
  })

  it('keeps the timeout message', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    mocks.runProcess.mockResolvedValue(exited({ code: null, timedOut: true }))

    await expect(runLocalAutomationCommand('openclaw', ['cron'])).rejects.toThrow(
      'Local automation command timed out after 30000ms.'
    )
  })

  it('surfaces stderr for a failed exit', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    mocks.runProcess.mockResolvedValue(exited({ code: 2, stderr: '  no such job \n' }))

    await expect(runLocalAutomationCommand('openclaw', ['cron'])).rejects.toThrow('no such job')
  })

  it('names an unknown exit code when stderr is empty', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    mocks.runProcess.mockResolvedValue(exited({ code: null }))

    await expect(runLocalAutomationCommand('openclaw', ['cron'])).rejects.toThrow(
      'Command exited with code unknown.'
    )
  })
})
