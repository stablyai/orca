import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalHost from './windows-administrator-terminal-host'

const mocks = vi.hoisted(() => ({
  identity: null as { pid: number; startedAtMs: number; launchNonce: string } | null,
  desktopAdministrator: vi.fn(),
  processAdministrator: vi.fn(),
  liveSessionIds: vi.fn(),
  restartDaemon: vi.fn(),
  consumeRestartRequest: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../daemon/daemon-provider-state', () => ({
  getDaemonProvider: () => ({}),
  listLiveDaemonPtyIds: mocks.liveSessionIds
}))
vi.mock('../daemon/daemon-provider-routing', () => ({
  getCurrentDaemonAdapter: () => ({ getDaemonIdentity: () => mocks.identity })
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: mocks.restartDaemon }))
vi.mock('./windows-administrator-restart', () => ({
  consumeLocalTerminalRestartRequest: mocks.consumeRestartRequest
}))
vi.mock('./windows-administrator-status', () => ({
  getWindowsAdministratorStatus: mocks.desktopAdministrator,
  getProcessAdministratorStatus: mocks.processAdministrator
}))

const standardHost = { pid: 4100, startedAtMs: 1, launchNonce: 'standard' }

async function load(): Promise<typeof TerminalHost> {
  vi.resetModules()
  return import('./windows-administrator-terminal-host')
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.identity = standardHost
  mocks.desktopAdministrator.mockReset().mockResolvedValue(true)
  mocks.processAdministrator.mockReset().mockResolvedValue(false)
  mocks.liveSessionIds.mockReset().mockResolvedValue(['pty-1', 'pty-2'])
  mocks.restartDaemon.mockReset().mockImplementation(async () => {
    mocks.identity = { pid: 4200, startedAtMs: 2, launchNonce: 'elevated' }
    return { killedCount: 2 }
  })
  mocks.consumeRestartRequest.mockReset().mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal host elevation', () => {
  it('replaces the host on an approved administrator restart', async () => {
    mocks.consumeRestartRequest.mockReturnValue(true)
    const host = await load()
    await host.reconcileTerminalHostElevation(new AbortController().signal)
    expect(mocks.restartDaemon).toHaveBeenCalledWith()
    expect(mocks.processAdministrator).not.toHaveBeenCalled()
  })

  it('leaves a busy standard host to the user, then restarts only that host on request', async () => {
    const host = await load()
    await host.reconcileTerminalHostElevation(new AbortController().signal)
    expect(mocks.processAdministrator).toHaveBeenCalledWith(4100)
    expect(mocks.restartDaemon).not.toHaveBeenCalled()
    await expect(host.readWindowsStandardTerminalHost()).resolves.toEqual({
      pid: 4100,
      liveSessionCount: 2
    })

    await expect(host.restartWindowsStandardTerminalHost(4100)).resolves.toEqual({
      status: 'restarted',
      killedCount: 2
    })
    expect(mocks.restartDaemon).toHaveBeenCalledWith({ expectedDaemonPid: 4100 })
    await expect(host.readWindowsStandardTerminalHost()).resolves.toBeNull()
  })

  it('silently replaces a standard host that has no terminals', async () => {
    mocks.liveSessionIds.mockResolvedValue([])
    const host = await load()
    await host.reconcileTerminalHostElevation(new AbortController().signal)
    expect(mocks.restartDaemon).toHaveBeenCalledWith({ expectedDaemonPid: 4100 })
    await expect(host.readWindowsStandardTerminalHost()).resolves.toBeNull()
  })

  it('stops offering the restart once the host was replaced another way', async () => {
    const host = await load()
    await host.reconcileTerminalHostElevation(new AbortController().signal)
    mocks.identity = { pid: 4300, startedAtMs: 3, launchNonce: 'manage-sessions' }
    await expect(host.readWindowsStandardTerminalHost()).resolves.toBeNull()
    await expect(host.restartWindowsStandardTerminalHost(4100)).resolves.toEqual({
      status: 'refused',
      reason: 'replaced'
    })
    expect(mocks.restartDaemon).not.toHaveBeenCalled()
  })

  it.each([
    ['a standard desktop', () => mocks.desktopAdministrator.mockResolvedValue(false)],
    ['an elevated host', () => mocks.processAdministrator.mockResolvedValue(true)],
    ['an unreadable host', () => mocks.processAdministrator.mockResolvedValue(null)]
  ])('keeps terminals untouched for %s', async (_case, arrange) => {
    arrange()
    const host = await load()
    await host.reconcileTerminalHostElevation(new AbortController().signal)
    expect(mocks.restartDaemon).not.toHaveBeenCalled()
    await expect(host.readWindowsStandardTerminalHost()).resolves.toBeNull()
  })
})
