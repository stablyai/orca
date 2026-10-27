import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  confirmQuitAndStopAllSessions,
  explainStopAllSessionsUnavailable
} from './quit-and-stop-all-sessions-prompt'

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
vi.mock('./quit-and-stop-all-sessions-prompt', () => ({
  confirmQuitAndStopAllSessions: prompt.confirm,
  explainStopAllSessionsUnavailable: prompt.explain
}))
vi.mock('../daemon/daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: daemon.holdingNewer
}))
vi.mock('../daemon/daemon-provider-state', () => ({ getDaemonProvider: daemon.provider }))
vi.mock('../ipc/pty/pty-management', () => ({
  confirmNoDaemonSessionsRemain: daemon.noSessionsRemain
}))
vi.mock('../updater', () => ({ checkForUpdatesFromMenu: vi.fn(), isQuittingForUpdate: vi.fn() }))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../window/attach-main-window-services', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { safelyRevealWindow } from '../window/focus-existing-window'
import {
  consumeQuitAndStopAllSessionsRequest,
  getAppMenuQuitHandlers,
  getSystemTrayOptions,
  quitAfterRendererStoppedAllSessions,
  quitAndStopAllSessionsFromUserCommand,
  quitFromUserCommand,
  setMainWindowOpener
} from './main-window-actions'
import { mainProcessState as state } from './main-process-state'

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
})

describe('quitAndStopAllSessionsFromUserCommand', () => {
  it('reveals the window, confirms on it, then asks its renderer to stop every session without quitting yet', async () => {
    prompt.confirm.mockImplementation(async (showMessageBox) => {
      await showMessageBox({ message: 'confirm' })
      return true
    })

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(electron.showMessageBox).toHaveBeenCalledWith(mainWindow, { message: 'confirm' })
    expect(vi.mocked(safelyRevealWindow).mock.invocationCallOrder[0]).toBeLessThan(
      prompt.confirm.mock.invocationCallOrder[0]
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('ui:quitAndStopAllSessions')
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(true)
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('opens a window when none is open and queues the request for its renderer', async () => {
    Object.assign(state, { mainWindow: null })
    const opened = fakeMainWindow()
    setMainWindowOpener(() => {
      Object.assign(state, { mainWindow: opened })
      return state.mainWindow ?? expect.unreachable()
    })
    prompt.confirm.mockImplementation(async (showMessageBox) => {
      await showMessageBox({ message: 'confirm' })
      return true
    })

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(electron.showMessageBox).toHaveBeenCalledWith({ message: 'confirm' })
    expect(opened.webContents.send).toHaveBeenCalledWith('ui:quitAndStopAllSessions')
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(true)
  })

  it('lets a request nobody consumed expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const confirmedAt = Date.now()
    prompt.confirm.mockResolvedValue(true)

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    vi.setSystemTime(confirmedAt + 29_000)
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(true)
    vi.setSystemTime(confirmedAt + 31_000)
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(false)
  })

  it('leaves Orca and its sessions alone when the user cancels', async () => {
    prompt.confirm.mockResolvedValue(false)

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(prompt.confirm).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(false)
  })

  it('shows one confirmation at a time, and a new one after it closes', async () => {
    const answer = Promise.withResolvers<boolean>()
    prompt.confirm.mockReturnValueOnce(answer.promise).mockResolvedValue(false)

    quitAndStopAllSessionsFromUserCommand()
    quitAndStopAllSessionsFromUserCommand()
    answer.resolve(false)
    await flushPromptChain()
    expect(prompt.confirm).toHaveBeenCalledOnce()

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()
    expect(prompt.confirm).toHaveBeenCalledTimes(2)
  })

  it('offers the confirmation again after one fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    prompt.confirm.mockRejectedValueOnce(new Error('dialog failed')).mockResolvedValue(false)

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()
    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(error).toHaveBeenCalledWith('[quit] Quit Completely failed:', expect.any(Error))
    expect(prompt.confirm).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'the terminal daemon is still starting or failed to start',
      () => daemon.provider.mockReturnValue(null)
    ],
    ["a newer version's daemon is held", () => daemon.holdingNewer.mockReturnValue(true)]
  ])('explains instead of asking, and stops nothing, while %s', async (_name, arrange) => {
    arrange()

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(prompt.explain).toHaveBeenCalledOnce()
    expect(prompt.confirm).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(false)
  })

  it('never stops the sessions of a serve host, whose user Quit does not exit', async () => {
    state.isServeMode = true

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(prompt.confirm).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
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

  it('stays open when the daemon still lists a session, and a later request can quit', async () => {
    daemon.noSessionsRemain.mockResolvedValueOnce(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)

    await expect(quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)).resolves.toBe(false)
    expect(electron.quit).not.toHaveBeenCalled()

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)
    await expect(quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)).resolves.toBe(true)
    expect(electron.quit).toHaveBeenCalledOnce()
  })

  it('reveals the window before the final user Quit', async () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)
    vi.mocked(safelyRevealWindow).mockClear()

    await quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)

    expect(safelyRevealWindow).toHaveBeenCalledWith(mainWindow)
    expect(vi.mocked(safelyRevealWindow).mock.invocationCallOrder[0]).toBeLessThan(
      electron.quit.mock.invocationCallOrder[0]
    )
    expect(state.isQuitting).toBe(true)
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

  it('quits even when stopping the sessions outlasts the request expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)

    // The renderer may wait 30 s for the restored session before Kill all even starts.
    vi.setSystemTime(Date.now() + 120_000)
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

describe('getSystemTrayOptions', () => {
  beforeEach(() => {
    Object.assign(state, { store: { getSettings: () => ({ appIcon: 'classic' }) } })
  })

  it('offers Quit Completely on a desktop app only', () => {
    expect(getSystemTrayOptions()?.onQuitAndStopAllSessions).toBe(
      quitAndStopAllSessionsFromUserCommand
    )

    state.isServeMode = true
    expect(getSystemTrayOptions()?.onQuitAndStopAllSessions).toBeUndefined()
  })
})

describe('getAppMenuQuitHandlers', () => {
  it('offers Quit Completely on a desktop app, and keeps a serve host on its own Quit', () => {
    expect(getAppMenuQuitHandlers()).toEqual({
      onQuitAndStopAllSessions: quitAndStopAllSessionsFromUserCommand
    })

    state.isServeMode = true
    expect(getAppMenuQuitHandlers()).toEqual({ onQuit: quitFromUserCommand })
  })
})
