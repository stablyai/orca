import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalAutomationCommandExecutor } from './external-automation-command-executor'
import { ExternalAutomationsHandler } from './external-automations-handler'
import type { RelayDispatcher } from './dispatcher'

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
      execCallback(null, '', '')
    }
  })
)

vi.mock('child_process', () => ({ execFile: execFileMock }))

type CapturedHandler = (params?: Record<string, unknown>) => Promise<unknown>

function createHandlerHarness(): Map<string, CapturedHandler> {
  const requestHandlers = new Map<string, CapturedHandler>()
  const dispatcher = {
    onRequest(method: string, handler: CapturedHandler): void {
      requestHandlers.set(method, handler)
    }
  }
  new ExternalAutomationsHandler(dispatcher as unknown as RelayDispatcher)
  return requestHandlers
}

beforeEach(() => {
  execFileMock.mockClear()
})

describe('ExternalAutomationsHandler', () => {
  it('preserves the five external automation routes', () => {
    expect([...createHandlerHarness().keys()]).toEqual([
      'externalAutomations.list',
      'externalAutomations.runs',
      'externalAutomations.create',
      'externalAutomations.update',
      'externalAutomations.act'
    ])
  })

  it('runs lifecycle actions without shell wrapping', async () => {
    const requestHandlers = createHandlerHarness()

    await requestHandlers.get('externalAutomations.act')?.({
      provider: 'hermes',
      action: 'run',
      jobId: 'job-1'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      ['cron', 'run', 'job-1'],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })

  it('propagates command failures through the registered route', async () => {
    const commandError = new Error('remote Hermes failed')
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void
      callback(commandError)
    })
    const requestHandlers = createHandlerHarness()

    await expect(
      requestHandlers.get('externalAutomations.act')?.({
        provider: 'hermes',
        action: 'run',
        jobId: 'job-1'
      })
    ).rejects.toBe(commandError)
  })
})

describe('ExternalAutomationCommandExecutor', () => {
  it.each([
    ['hermes', 'pause', 'pause'],
    ['hermes', 'resume', 'resume'],
    ['hermes', 'run', 'run'],
    ['hermes', 'delete', 'remove'],
    ['openclaw', 'pause', 'disable'],
    ['openclaw', 'resume', 'enable'],
    ['openclaw', 'run', 'run'],
    ['openclaw', 'delete', 'rm']
  ])('maps %s %s to its provider command', async (provider, action, command) => {
    const runCommand = vi.fn().mockResolvedValue(undefined)
    const executor = new ExternalAutomationCommandExecutor(runCommand, vi.fn())

    await executor.runAction({ provider, action, jobId: 'job-1' })

    expect(runCommand).toHaveBeenCalledWith(provider, ['cron', command, 'job-1'], {
      encoding: 'utf-8',
      timeout: 30_000
    })
  })

  it('does not clear count state when a command fails', async () => {
    const commandError = new Error('command failed')
    const clearRunCount = vi.fn()
    const executor = new ExternalAutomationCommandExecutor(
      vi.fn().mockRejectedValue(commandError),
      clearRunCount
    )

    await expect(
      executor.runAction({ provider: 'hermes', action: 'run', jobId: 'job-1' })
    ).rejects.toBe(commandError)
    expect(clearRunCount).not.toHaveBeenCalled()
  })

  it('preserves Hermes create arguments and clears all cached counts after success', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined)
    const clearRunCount = vi.fn()
    const executor = new ExternalAutomationCommandExecutor(runCommand, clearRunCount)

    await executor.createJob({
      provider: 'hermes',
      name: 'Nightly review',
      prompt: 'Review the workspace',
      schedule: '0 2 * * *',
      workdir: '/remote/workspace'
    })

    expect(runCommand).toHaveBeenCalledWith(
      'hermes',
      [
        'cron',
        'create',
        '0 2 * * *',
        'Review the workspace',
        '--name',
        'Nightly review',
        '--deliver',
        'local',
        '--workdir',
        '/remote/workspace'
      ],
      { encoding: 'utf-8', timeout: 30_000 }
    )
    expect(clearRunCount).toHaveBeenCalledWith()
  })

  it('preserves Hermes update arguments and clears only the edited job count', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined)
    const clearRunCount = vi.fn()
    const executor = new ExternalAutomationCommandExecutor(runCommand, clearRunCount)

    await executor.updateJob({
      provider: 'hermes',
      jobId: 'job-1',
      name: 'Updated review',
      prompt: 'Review changes',
      schedule: '15 3 * * *'
    })

    expect(runCommand).toHaveBeenCalledWith(
      'hermes',
      [
        'cron',
        'edit',
        'job-1',
        '--schedule',
        '15 3 * * *',
        '--prompt',
        'Review changes',
        '--name',
        'Updated review'
      ],
      { encoding: 'utf-8', timeout: 30_000 }
    )
    expect(clearRunCount).toHaveBeenCalledWith('job-1')
  })

  it('preserves update validation order', async () => {
    const executor = new ExternalAutomationCommandExecutor(vi.fn(), vi.fn())

    await expect(
      executor.updateJob({ provider: 'hermes', jobId: '--help', prompt: '', schedule: '' })
    ).rejects.toThrow('Hermes cron requires a prompt.')
  })
})
