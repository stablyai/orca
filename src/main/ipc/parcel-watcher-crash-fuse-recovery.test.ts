import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRASH_FUSE_COOLDOWN_INITIAL_MS } from './filesystem/watcher-process/parcel-watcher-crash-fuse'
import {
  acknowledgeWatcherSubscribe as ackSubscribe,
  currentWatcherChild,
  FakeWatcherChild as FakeChild
} from './filesystem/watcher-process/parcel-watcher-process-test-child'

const { forkMock, existsSyncMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-canary-fuse-test'),
  rmSync: vi.fn()
}))

import { createWatcherProcessSupervisor } from './filesystem/watcher-process/parcel-watcher-process'

const currentChild = (): FakeChild => currentWatcherChild(forkMock)

function crashCurrentChild(): void {
  const child = currentChild()
  child.connected = false
  child.emit('exit', null, 'SIGSEGV')
}

describe('watcher crash fuse recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    vi.stubEnv('VITEST', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeChild())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('falls back while the fuse is open and retries native watching after the cooldown', async () => {
    const supervisor = createWatcherProcessSupervisor()
    const onTerminalError = vi.fn()
    const subscription = supervisor.subscribe('/repo', vi.fn(), {}, { onTerminalError })
    ackSubscribe(currentChild())
    await subscription

    for (let crash = 0; crash < 2; crash++) {
      vi.setSystemTime(Date.now() + 30_000)
      crashCurrentChild()
      ackSubscribe(currentChild())
    }
    vi.setSystemTime(Date.now() + 30_000)
    crashCurrentChild()

    expect(forkMock).toHaveBeenCalledTimes(3)
    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'supervisor_crash_fuse' })
    )
    await expect(supervisor.subscribe('/repo', vi.fn(), {})).rejects.toMatchObject({
      code: 'process_unavailable'
    })
    expect(forkMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(Date.now() + CRASH_FUSE_COOLDOWN_INITIAL_MS)
    const retried = supervisor.subscribe('/repo', vi.fn(), {})
    expect(forkMock).toHaveBeenCalledTimes(4)
    ackSubscribe(currentChild())
    await expect(retried).resolves.toBeDefined()
    supervisor.dispose()
  })
})
