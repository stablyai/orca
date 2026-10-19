import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: {
    identityPid: number
    connectError: Error | null
    request: ReturnType<typeof vi.fn>
    killStaleDaemon: ReturnType<typeof vi.fn>
  } = {
    identityPid: 4288,
    connectError: null,
    request: vi.fn(async () => ({ sessions: [] })),
    killStaleDaemon: vi.fn(async () => ({ killed: true, liveOwnerSurvived: false }))
  }
  return state
})

vi.mock('./daemon-launch-paths', () => ({ probeDaemonSocket: vi.fn(async () => true) }))
vi.mock('./daemon-stale-kill', () => ({ killStaleDaemon: mocks.killStaleDaemon }))
vi.mock('./client', () => ({
  DaemonClient: class {
    async ensureConnected(): Promise<void> {
      if (mocks.connectError) {
        throw mocks.connectError
      }
    }
    getDaemonIdentity() {
      return { pid: mocks.identityPid, startedAtMs: 1, launchNonce: 'n' }
    }
    request = mocks.request
    disconnect(): void {}
  }
}))

import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'

afterEach(() => {
  mocks.identityPid = 4288
  mocks.connectError = null
  vi.clearAllMocks()
})

describe('cleanupDaemonForProtocol with an expected owner', () => {
  it('never shuts down a different endpoint owner', async () => {
    mocks.identityPid = 9000
    await expect(cleanupDaemonForProtocol('/runtime', 1, 4288)).rejects.toThrow(
      'owned by a different daemon'
    )
    expect(mocks.request).not.toHaveBeenCalledWith('shutdown', expect.anything())
    expect(mocks.killStaleDaemon).not.toHaveBeenCalled()
  })

  it('never falls back to a pid kill when the owner cannot be verified', async () => {
    mocks.connectError = new Error('connect failed')
    await expect(cleanupDaemonForProtocol('/runtime', 1, 4288)).rejects.toThrow(
      'could not be verified'
    )
    expect(mocks.killStaleDaemon).not.toHaveBeenCalled()
  })

  it('keeps the untargeted pid-kill fallback for unreachable daemons', async () => {
    mocks.connectError = new Error('connect failed')
    await expect(cleanupDaemonForProtocol('/runtime', 1)).resolves.toMatchObject({ cleaned: true })
    expect(mocks.killStaleDaemon).toHaveBeenCalledOnce()
  })
})
