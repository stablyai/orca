import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeUploadFileStreamRequest } from '../../shared/runtime-upload-staging-contract'

const callRuntimeEnvironment =
  vi.fn<
    (
      userDataPath: string,
      environmentId: string,
      method: string,
      params: { relativePath: string; recursive: boolean },
      timeoutMs?: number,
      expectedEnvironmentPairingRevision?: number,
      envelope?: unknown,
      options?: { expectedEnvironmentRuntimeId?: string }
    ) => unknown
  >()

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: Parameters<typeof callRuntimeEnvironment>) =>
    callRuntimeEnvironment(...args)
}))

const { sweepAbandonedRuntimeUploadTempPath } = await import('./runtime-upload-temp-sweep')

const request: RuntimeUploadFileStreamRequest = {
  environmentId: 'env-1',
  sourceRootPath: '/Users/me/clip.mp4',
  entryRelativePath: '',
  expected: { byteLength: 4, inode: 1, deviceId: 2, modifiedAtMs: 3 },
  worktree: 'id:wt-1',
  relativePath: 'uploads/.clip.mp4.orca-upload-abc',
  expectedEnvironmentPairingRevision: 17,
  expectedEnvironmentRuntimeId: 'runtime-7',
  expectedExecutionHostId: 'local'
}

function deleteCalls(): { relativePath: string; recursive: boolean }[] {
  return callRuntimeEnvironment.mock.calls
    .filter(([, , method]) => method === 'files.delete')
    .map(([, , , params]) => params)
}

beforeEach(() => {
  vi.useFakeTimers()
  callRuntimeEnvironment.mockReset()
  callRuntimeEnvironment.mockResolvedValue({ id: 'x', ok: true, result: {}, _meta: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sweepAbandonedRuntimeUploadTempPath', () => {
  it('deletes twice, because a straggling append recreates the file with flag a', async () => {
    const swept = sweepAbandonedRuntimeUploadTempPath('/user-data', request)
    await vi.runAllTimersAsync()
    await swept

    expect(deleteCalls()).toEqual([
      expect.objectContaining({ relativePath: request.relativePath, recursive: false }),
      expect.objectContaining({ relativePath: request.relativePath, recursive: false })
    ])
  })

  it('still makes the second pass when the first one fails', async () => {
    callRuntimeEnvironment.mockRejectedValueOnce(new Error('connection lost'))

    const swept = sweepAbandonedRuntimeUploadTempPath('/user-data', request)
    await vi.runAllTimersAsync()
    await expect(swept).resolves.toBeUndefined()

    expect(deleteCalls()).toHaveLength(2)
  })

  it('carries the host ownership guards so it cannot delete on a re-paired host', async () => {
    const swept = sweepAbandonedRuntimeUploadTempPath('/user-data', request)
    await vi.runAllTimersAsync()
    await swept

    for (const call of callRuntimeEnvironment.mock.calls) {
      expect(call[5]).toBe(17)
      expect(call[7]?.expectedEnvironmentRuntimeId).toBe('runtime-7')
    }
  })

  it('never rejects, so cleanup cannot mask the upload failure', async () => {
    callRuntimeEnvironment.mockRejectedValue(new Error('runtime gone'))

    const swept = sweepAbandonedRuntimeUploadTempPath('/user-data', request)
    await vi.runAllTimersAsync()

    await expect(swept).resolves.toBeUndefined()
  })
})
