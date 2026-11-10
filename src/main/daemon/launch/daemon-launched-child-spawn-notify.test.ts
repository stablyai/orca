import { describe, expect, it, vi } from 'vitest'
import { nextDaemonChildSpawn, spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { forkProcessMock } = vi.hoisted(() => ({ forkProcessMock: vi.fn(() => ({ pid: 1 })) }))
vi.mock('@orca/process-host/fork-process', () => ({ forkProcess: forkProcessMock }))
vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '0.0.0-test' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))

const OPTIONS = {
  entryPath: '/fake/daemon-entry.js',
  forkEntryPath: '/fake/daemon-entry.js',
  userDataPath: '/fake/userData',
  socketPath: '/fake/socket',
  tokenPath: '/fake/token',
  pidPath: '/fake/daemon.pid',
  launchNonce: 'nonce',
  macosLoginSessionWatch: false
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

describe('nextDaemonChildSpawn', () => {
  it('resolves on the next daemon child spawn, and only waiters registered before it', async () => {
    const before = nextDaemonChildSpawn()
    expect(await settled(before)).toBe(false)

    spawnDaemonChildProcess(OPTIONS, false)
    expect(forkProcessMock).toHaveBeenCalledOnce()
    expect(await settled(before)).toBe(true)

    const after = nextDaemonChildSpawn()
    expect(await settled(after)).toBe(false)
    spawnDaemonChildProcess(OPTIONS, false)
    expect(await settled(after)).toBe(true)
  })
})
