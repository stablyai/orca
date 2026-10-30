import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WatcherChildRegistry from './parcel-watcher-child-registry'

const { forkMock, releaseReservationMock, signalPhysicalExitMock, writeFileSyncMock } = vi.hoisted(
  () => ({
    forkMock: vi.fn(),
    releaseReservationMock: vi.fn(),
    signalPhysicalExitMock: vi.fn(),
    writeFileSyncMock: vi.fn()
  })
)

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ writeFileSync: writeFileSyncMock }))
vi.mock('./parcel-watcher-canary-directory', () => ({
  createWatcherCanaryDirectory: vi.fn(() => null),
  removeWatcherCanaryDirectory: vi.fn()
}))
vi.mock('./parcel-watcher-child-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof WatcherChildRegistry>()),
  reserveWatcherChild: vi.fn(() => releaseReservationMock)
}))
vi.mock('./parcel-watcher-child-termination', () => ({
  registerWatcherChildPhysicalExit: vi.fn(() => signalPhysicalExitMock)
}))

import { launchWatcherChild } from './parcel-watcher-child-launch'
import { reserveWatcherChild, WatcherChildCapacityError } from './parcel-watcher-child-registry'

class LaunchChild extends EventEmitter {
  pid = 1234
  stderr = new EventEmitter()
}

describe('launchWatcherChild', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_WATCHER_CHILD_PID_FILE', '/tmp/orca-watcher.pid')
    forkMock.mockReturnValue(new LaunchChild())
    releaseReservationMock.mockReset()
    signalPhysicalExitMock.mockReset()
    writeFileSyncMock.mockReset()
    vi.mocked(reserveWatcherChild).mockReturnValue(releaseReservationMock)
  })

  it('preserves typed transient capacity exhaustion without forking', () => {
    vi.mocked(reserveWatcherChild).mockReturnValueOnce(null)

    expect(() => launchWatcherChild('/watcher.js', null, vi.fn(), vi.fn())).toThrow(
      WatcherChildCapacityError
    )
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('creates the fault-harness pid file without clobbering an existing path', () => {
    expect(launchWatcherChild('/watcher.js', null, vi.fn(), vi.fn())).not.toBeNull()
    expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/orca-watcher.pid', '1234', {
      flag: 'wx'
    })
  })

  it('releases physical capacity when an async spawn failure closes without exit', () => {
    const child = new LaunchChild()
    forkMock.mockReturnValue(child)
    const onGone = vi.fn()

    expect(launchWatcherChild('/watcher.js', null, vi.fn(), onGone)).not.toBeNull()
    child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
    child.emit('close', -2, null)
    child.emit('exit', -2, null)

    expect(onGone).toHaveBeenCalledTimes(2)
    expect(signalPhysicalExitMock).toHaveBeenCalledTimes(1)
    expect(releaseReservationMock).toHaveBeenCalledTimes(1)
  })
})
