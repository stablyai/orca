import { beforeEach, describe, expect, it, vi } from 'vitest'

const runFormatOnSaveMock = vi.hoisted(() => vi.fn())
vi.mock('./format-on-save-runner', () => ({ runFormatOnSave: runFormatOnSaveMock }))

import { runRepoFormatOnSave } from './format-on-save-repo'

const formatOnSave = { enabled: true, command: 'fmt ${file}', include: [] }
const request = { worktreePath: '/repo', absoluteFilePath: '/repo/a.ts' }

beforeEach(() => {
  runFormatOnSaveMock.mockReset()
  runFormatOnSaveMock.mockResolvedValue({ status: 'completed' })
})

describe('runRepoFormatOnSave', () => {
  it('runs the repo command on a local repo', async () => {
    await expect(runRepoFormatOnSave({ repo: { formatOnSave }, ...request })).resolves.toEqual({
      status: 'completed'
    })
    expect(runFormatOnSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ command: 'fmt ${file}' }) })
    )
  })

  it('skips an unconfigured repo', async () => {
    await expect(runRepoFormatOnSave({ repo: {}, ...request })).resolves.toEqual({
      status: 'skipped',
      reason: 'not-configured'
    })
  })

  it.each([
    { executionHostId: 'ssh:box' as const },
    { executionHostId: 'runtime:env-1' as const },
    { connectionId: 'box' }
  ])('skips a repo owned by another host (%o) instead of running here', async (owner) => {
    await expect(
      runRepoFormatOnSave({ repo: { formatOnSave, ...owner }, ...request })
    ).resolves.toEqual({ status: 'skipped', reason: 'unsupported-host' })
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })
})
