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

const OPENCLAW_CMD =
  process.platform === 'win32'
    ? 'C:\\Users\\ada\\AppData\\Roaming\\npm\\openclaw.cmd'
    : '/home/ada/.nvm/versions/node/v22.14.0/bin/openclaw'
const OPENCLAW_DIR =
  process.platform === 'win32'
    ? 'C:\\Users\\ada\\AppData\\Roaming\\npm'
    : '/home/ada/.nvm/versions/node/v22.14.0/bin'
const PATH_DELIMITER = process.platform === 'win32' ? ';' : ':'

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

    const spec = mocks.runProcess.mock.calls[0]?.[0]
    expect(spec.program).toBe(OPENCLAW_CMD)
    expect(spec.program).not.toBe('openclaw')
    expect(spec.args).toEqual(['cron', 'list'])
    expect(spec.timeoutMs).toBe(30_000)
  })

  it('puts the resolved command directory first on the child PATH', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue(OPENCLAW_CMD)
    mocks.runProcess.mockResolvedValue(exited())

    await runLocalAutomationCommand('openclaw', ['cron'])

    const spec = mocks.runProcess.mock.calls[0]?.[0]
    const pathKey = Object.keys(spec.env ?? {}).find((key) => key.toLowerCase() === 'path')
    expect(pathKey).toBeDefined()
    const childPathEntries = String(spec.env[pathKey as string]).split(PATH_DELIMITER)
    expect(childPathEntries[0]).toBe(OPENCLAW_DIR)
    expect(childPathEntries.filter((entry) => entry === OPENCLAW_DIR)).toHaveLength(1)
  })

  it('passes no env override when resolution leaves the command unchanged', async () => {
    mocks.resolveCliCommandAsync.mockResolvedValue('openclaw')
    mocks.runProcess.mockResolvedValue(exited())

    await runLocalAutomationCommand('openclaw', ['cron'])

    expect(mocks.runProcess).toHaveBeenCalledWith({
      program: 'openclaw',
      args: ['cron'],
      timeoutMs: 30_000
    })
    expect(mocks.runProcess.mock.calls[0]?.[0]).not.toHaveProperty('env')
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
