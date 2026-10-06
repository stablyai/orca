import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { captureSpawnedRootCreationTimeMs } from './spawn-root-identity'
import { __setConptyJobNativeForTests, terminatePtyJob } from '../../windows/windows-pty-job'

let platformDescriptor: PropertyDescriptor | undefined
const getShellCreationTime = vi.fn()

function proc(pid = 4242, useConpty: unknown = true): IPty {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Identity capture reads only these native identity fields.
  return { pid, _pty: 7, _agent: { _useConpty: useConpty } } as unknown as IPty
}

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  getShellCreationTime.mockReset().mockReturnValue(1234)
  __setConptyJobNativeForTests(() => ({
    getShellCreationTime,
    terminateJob: vi.fn(),
    listJobProcessIds: vi.fn(),
    assignCurrentProcessToJob: vi.fn()
  }))
})

afterEach(() => {
  __setConptyJobNativeForTests()
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
})

describe('captureSpawnedRootCreationTimeMs', () => {
  it('reads the owned shell handle synchronously without a process-table scan', () => {
    expect(captureSpawnedRootCreationTimeMs(proc())).toBe(1234)
    expect(getShellCreationTime).toHaveBeenCalledWith(7, 4242)
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses the invalid pid %p', (pid) => {
    expect(captureSpawnedRootCreationTimeMs(proc(pid))).toBeUndefined()
    expect(getShellCreationTime).not.toHaveBeenCalled()
  })

  it.each([false, undefined])('refuses non-ConPTY handles with backend marker %p', (marker) => {
    const process = proc()
    Object.assign(process, { _agent: { _useConpty: marker } })
    expect(captureSpawnedRootCreationTimeMs(process)).toBeUndefined()
    expect(getShellCreationTime).not.toHaveBeenCalled()
  })

  it('refuses Bun wrapper PIDs without treating their jobs as unavailable', () => {
    const process = proc()
    Object.assign(process, {
      _agent: undefined,
      jobRootProcessIsWrapper: true,
      shellProcessId: 9001,
      terminateOwnedTree: () => 'terminated' as const
    })
    expect(captureSpawnedRootCreationTimeMs(process)).toBeUndefined()
    expect(getShellCreationTime).not.toHaveBeenCalled()
    expect(terminatePtyJob(process)).toBe('terminated')
  })

  it('cannot adopt a replacement PID after the native shell handle closes', () => {
    getShellCreationTime.mockReturnValue(undefined)
    expect(captureSpawnedRootCreationTimeMs(proc())).toBeUndefined()
    expect(getShellCreationTime).toHaveBeenCalledOnce()
  })

  it('fails closed on an older addon without the stable-handle reader', () => {
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn()
    }))
    expect(captureSpawnedRootCreationTimeMs(proc())).toBeUndefined()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'refuses an invalid creation time %p',
    (value) => {
      getShellCreationTime.mockReturnValue(value)
      expect(captureSpawnedRootCreationTimeMs(proc())).toBeUndefined()
    }
  )

  it('tolerates an unavailable native reader without failing spawn', () => {
    getShellCreationTime.mockImplementation(() => {
      throw new Error('handle unavailable')
    })
    expect(captureSpawnedRootCreationTimeMs(proc())).toBeUndefined()
  })

  it('does not read native Windows identity on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(captureSpawnedRootCreationTimeMs(proc())).toBeUndefined()
    expect(getShellCreationTime).not.toHaveBeenCalled()
  })
})
