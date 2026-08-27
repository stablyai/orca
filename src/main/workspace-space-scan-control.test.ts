import { describe, expect, it } from 'vitest'
import { WorkspaceSpaceScanCapacityError } from '../shared/workspace-space-scan-budget'
import {
  WorkspaceSpaceScanCancelledError,
  classifyWorkspaceSpaceError,
  createWorkspaceSpaceScanLimiter
} from './workspace-space-scan-control'

describe('workspace space scan boundaries', () => {
  it.each([
    [{ code: 'ENOENT', message: 'gone' }, 'missing'],
    [{ code: 'ENOTDIR', message: 'not a directory' }, 'missing'],
    [{ code: 'EACCES', message: 'denied' }, 'permission-denied'],
    [{ code: 'EPERM', message: 'denied' }, 'permission-denied'],
    [new Error('other'), 'error']
  ] as const)('classifies %o as %s without changing error semantics', (error, status) => {
    expect(classifyWorkspaceSpaceError(error).status).toBe(status)
  })

  it('keeps capacity exhaustion distinct from filesystem errors', () => {
    const error = new WorkspaceSpaceScanCapacityError({ maxEntries: 1, maxRetainedBytes: 1 })
    expect(classifyWorkspaceSpaceError(error)).toEqual({
      status: 'unavailable',
      message: error.message
    })
  })

  it('rejects queued work with the public cancellation error', async () => {
    const controller = new AbortController()
    const limit = createWorkspaceSpaceScanLimiter(1, controller.signal)
    let release!: () => void
    const active = limit(() => new Promise<void>((resolve) => (release = resolve)))
    const queued = limit(async () => undefined)
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(WorkspaceSpaceScanCancelledError)
    release()
    await active
  })
})
