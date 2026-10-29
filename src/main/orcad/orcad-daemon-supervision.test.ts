import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  initDaemonPtyProviderMock,
  disconnectDaemonMock,
  shutdownDaemonMock,
  daemonOwnsFreshPersistentPtysMock,
  readDaemonPidRecordMock
} = vi.hoisted(() => ({
  initDaemonPtyProviderMock: vi.fn<(signal?: unknown, options?: unknown) => Promise<void>>(),
  disconnectDaemonMock: vi.fn<() => Promise<void>>(),
  shutdownDaemonMock: vi.fn<() => Promise<void>>(),
  daemonOwnsFreshPersistentPtysMock: vi.fn<() => boolean>(),
  readDaemonPidRecordMock: vi.fn<() => { pid: number } | null>()
}))

vi.mock('../daemon/daemon-provider-init', () => ({
  initDaemonPtyProvider: initDaemonPtyProviderMock
}))
vi.mock('../daemon/daemon-provider-state', () => ({
  disconnectDaemon: disconnectDaemonMock,
  shutdownDaemon: shutdownDaemonMock,
  daemonOwnsFreshPersistentPtys: daemonOwnsFreshPersistentPtysMock,
  readDaemonPidRecord: readDaemonPidRecordMock
}))

const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')

beforeEach(() => {
  initDaemonPtyProviderMock.mockResolvedValue()
  disconnectDaemonMock.mockResolvedValue()
  shutdownDaemonMock.mockResolvedValue()
  daemonOwnsFreshPersistentPtysMock.mockReturnValue(true)
  readDaemonPidRecordMock.mockReturnValue({ pid: 4242 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('startOrcadDaemon', () => {
  it('reports live with the daemon pid once the provider is installed', async () => {
    await expect(startOrcadDaemon()).resolves.toEqual({ state: 'live', pid: 4242 })
  })

  it('does not arm the macOS login-session death watch', async () => {
    await startOrcadDaemon()
    expect(initDaemonPtyProviderMock).toHaveBeenCalledWith(undefined, {
      macosLoginSessionWatch: false,
      recycleStaleDaemonOnEveryPlatform: true,
      spawnAdmission: 'enforce'
    })
  })

  it('gives a cold Windows daemon a longer startup budget', async () => {
    await startOrcadDaemon('win32')
    expect(initDaemonPtyProviderMock).toHaveBeenCalledWith(undefined, {
      macosLoginSessionWatch: false,
      recycleStaleDaemonOnEveryPlatform: true,
      spawnAdmission: 'enforce',
      startupTimeoutMs: 30_000
    })
  })

  it('retries the daemon spawn once before falling back to in-process terminals', async () => {
    initDaemonPtyProviderMock.mockRejectedValueOnce(new Error('Daemon startup timed out'))
    await expect(startOrcadDaemon()).resolves.toEqual({ state: 'live', pid: 4242 })
    expect(initDaemonPtyProviderMock).toHaveBeenCalledTimes(2)
  })

  it('reports degraded when fresh terminals would fall back to the local provider', async () => {
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    const result = await startOrcadDaemon()
    expect(result.state).toBe('degraded')
  })

  it('fails open when the daemon cannot start at all', async () => {
    initDaemonPtyProviderMock.mockRejectedValue(new Error('node-pty is missing'))
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    await expect(startOrcadDaemon()).resolves.toEqual({
      state: 'unavailable',
      reason: 'node-pty is missing'
    })
    expect(initDaemonPtyProviderMock).toHaveBeenCalledTimes(2)
  })
})

describe('stopOrcadDaemon', () => {
  it('disconnects and never shuts the daemon down', async () => {
    await stopOrcadDaemon()
    expect(disconnectDaemonMock).toHaveBeenCalledTimes(1)
    expect(shutdownDaemonMock).not.toHaveBeenCalled()
  })
})
