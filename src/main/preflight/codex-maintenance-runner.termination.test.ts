import { expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { CodexMaintenanceRunner } from './codex-maintenance-runner'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('./codex-maintenance-process', () => ({ executeCodexMaintenanceProcess: execute }))
vi.mock('./codex-maintenance-command', () => ({ resolveCodexMaintenanceCommand: vi.fn() }))

it('settles an unverifiable job, re-derives whether its owned root is live, and permits a later explicit retry', async () => {
  let live = true
  execute.mockResolvedValueOnce({
    code: null,
    error: 'Process termination is unverifiable.',
    termination: 'unverifiable',
    isLive: () => live
  })
  const resolve = vi.fn().mockResolvedValue({
    installation: codexCliInstallation(false, null),
    spec: { program: 'fake-installer' }
  })
  const invalidate = vi.fn()
  const runner = new CodexMaintenanceRunner({ resolve, invalidate, spawn: vi.fn() })
  const first = await runner.start()
  await vi.waitFor(async () => {
    const state = await runner.status(first.job?.id)
    expect(state.job?.phase).toBe('completed')
    expect(state.job?.termination).toBe('unverifiable')
    expect(state.job?.output).toContain('\nProcess termination is unverifiable.\n')
    expect(state.canRun).toBe(false)
  })
  await expect(runner.start()).rejects.toThrow('still live')
  expect(execute).toHaveBeenCalledOnce()
  expect(invalidate).toHaveBeenCalledOnce()
  live = false
  execute.mockResolvedValueOnce({
    code: 0,
    error: null,
    termination: 'exited',
    isLive: () => false
  })
  const retry = await runner.start()
  expect(retry.job?.id).not.toBe(first.job?.id)
  await vi.waitFor(async () => {
    expect((await runner.status(retry.job?.id)).job?.phase).toBe('completed')
  })
  expect(execute).toHaveBeenCalledTimes(2)
})
