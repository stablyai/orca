import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  confirmQuitAndStopAllSessions,
  explainStopAllSessionsUnavailable
} from '../quit/quit-and-stop-all-sessions-prompt'

const electron = vi.hoisted(() => ({ quit: vi.fn(), showMessageBox: vi.fn() }))
const prompt = vi.hoisted(() => ({
  confirm: vi.fn<typeof confirmQuitAndStopAllSessions>(),
  explain: vi.fn<typeof explainStopAllSessionsUnavailable>()
}))
const daemon = vi.hoisted(() => ({
  holdingNewer: vi.fn(() => false),
  provider: vi.fn<() => object | null>(() => ({})),
  noSessionsRemain: vi.fn<() => Promise<boolean>>()
}))

vi.mock('electron', () => ({
  app: { quit: electron.quit },
  dialog: { showMessageBox: electron.showMessageBox }
}))
vi.mock('../quit/quit-and-stop-all-sessions-prompt', () => ({
  confirmQuitAndStopAllSessions: prompt.confirm,
  explainStopAllSessionsUnavailable: prompt.explain
}))
vi.mock('../../daemon/providers/routing/daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: daemon.holdingNewer
}))
vi.mock('../../daemon/providers/lifecycle/daemon-provider-state', () => ({
  getDaemonProvider: daemon.provider
}))
vi.mock('../../ipc/pty/pty-management', () => ({
  confirmNoDaemonSessionsRemain: daemon.noSessionsRemain
}))
vi.mock('../../updater/updater-service', () => ({
  checkForUpdatesFromMenu: vi.fn(),
  isQuittingForUpdate: vi.fn()
}))
vi.mock('../../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../../window/main-window-updater', () => ({
  ensureAutoUpdaterConfigured: vi.fn()
}))
vi.mock('../../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('../windows-install-permissions/windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../../window/renderer-launch-failure-probe', () => ({
  probeRendererLaunchCapacity: vi.fn()
}))

import { safelyRevealWindow } from '../../window/focus-existing-window'
import {
  consumeQuitAndStopAllSessionsRequest,
  quitAfterRendererStoppedAllSessions,
  quitAndStopAllSessionsFromUserCommand
} from './main-window-actions'
import { mainProcessState as state } from '../main-process-state'
import { quitTeardownStartGate } from '../quit/quit-teardown-start-gate'

const MAIN_WEB_CONTENTS_ID = 7

function fakeMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: { id: MAIN_WEB_CONTENTS_ID, send: vi.fn<(channel: string) => void>() }
  }
}

function flushPromptChain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let mainWindow: ReturnType<typeof fakeMainWindow>

beforeEach(() => {
  electron.quit.mockReset()
  electron.showMessageBox.mockReset()
  prompt.confirm.mockReset()
  prompt.explain.mockReset().mockResolvedValue(false)
  daemon.holdingNewer.mockReset().mockReturnValue(false)
  daemon.provider.mockReset().mockReturnValue({})
  daemon.noSessionsRemain.mockReset().mockResolvedValue(true)
  vi.mocked(safelyRevealWindow).mockReset()
  state.isQuitting = false
  state.isServeMode = false
  state.pendingQuitAndStopAllSessions.clear()
  mainWindow = fakeMainWindow()
  Object.assign(state, { mainWindow })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  quitTeardownStartGate.resetForTests()
})

describe('quitAfterRendererStoppedAllSessions', () => {
  beforeEach(async () => {
    prompt.confirm.mockResolvedValue(true)
    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()
  })

  it('quits once when the renderer that consumed the request reports every session stopped', async () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(false)

    const results = await Promise.all([
      quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID),
      quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)
    ])

    expect(results).toEqual([true, false])
    expect(electron.quit).toHaveBeenCalledOnce()
  })

  it('ignores a renderer other than the one that consumed the request', async () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)

    await expect(quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID + 1)).resolves.toBe(false)
    expect(electron.quit).not.toHaveBeenCalled()
    expect(daemon.noSessionsRemain).not.toHaveBeenCalled()

    // The stray sender must not use up the consumer's authorization either.
    await quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)
    expect(electron.quit).toHaveBeenCalledOnce()
  })

  it('ignores a renderer that never consumed the request', async () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID + 1)).toBe(false)

    await quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID + 1)
    await quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)

    expect(electron.quit).not.toHaveBeenCalled()
  })
})
