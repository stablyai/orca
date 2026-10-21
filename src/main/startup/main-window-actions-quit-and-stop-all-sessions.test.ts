import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ quit: vi.fn(), showMessageBox: vi.fn() }))
const prompt = vi.hoisted(() => ({ confirm: vi.fn<() => Promise<boolean>>() }))

vi.mock('electron', () => ({
  app: { quit: electron.quit },
  dialog: { showMessageBox: electron.showMessageBox }
}))
vi.mock('./quit-and-stop-all-sessions-prompt', () => ({
  confirmQuitAndStopAllSessions: prompt.confirm
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

import {
  consumeQuitAndStopAllSessionsRequest,
  getSystemTrayOptions,
  quitAfterRendererStoppedAllSessions,
  quitAndStopAllSessionsFromUserCommand
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

describe('quitAndStopAllSessionsFromUserCommand', () => {
  let mainWindow: ReturnType<typeof fakeMainWindow>

  beforeEach(() => {
    electron.quit.mockReset()
    prompt.confirm.mockReset()
    state.isQuitting = false
    state.isServeMode = false
    state.pendingQuitAndStopAllSessions.clear()
    mainWindow = fakeMainWindow()
    Object.assign(state, { mainWindow })
  })

  it('asks the renderer to stop every session once the user confirms, without quitting yet', async () => {
    prompt.confirm.mockResolvedValue(true)

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('ui:quitAndStopAllSessions')
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(true)
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('leaves Orca and its sessions alone when the user cancels', async () => {
    prompt.confirm.mockResolvedValue(false)

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(state.pendingQuitAndStopAllSessions.matches(MAIN_WEB_CONTENTS_ID)).toBe(false)
  })

  it('shows one confirmation at a time', async () => {
    let answer: (confirmed: boolean) => void = () => {}
    prompt.confirm.mockReturnValue(new Promise((resolve) => (answer = resolve)))

    quitAndStopAllSessionsFromUserCommand()
    quitAndStopAllSessionsFromUserCommand()
    answer(false)
    await flushPromptChain()

    expect(prompt.confirm).toHaveBeenCalledOnce()
  })

  it('never stops the sessions of a serve host, which belong to its paired clients', async () => {
    state.isServeMode = true

    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()

    expect(prompt.confirm).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})

describe('quitAfterRendererStoppedAllSessions', () => {
  beforeEach(async () => {
    electron.quit.mockReset()
    prompt.confirm.mockReset().mockResolvedValue(true)
    state.isQuitting = false
    state.isServeMode = false
    state.pendingQuitAndStopAllSessions.clear()
    Object.assign(state, { mainWindow: fakeMainWindow() })
    quitAndStopAllSessionsFromUserCommand()
    await flushPromptChain()
  })

  it('quits once the renderer that consumed the request reports every session stopped', () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(true)
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID)).toBe(false)

    quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)

    expect(electron.quit).toHaveBeenCalledOnce()
  })

  it('ignores a renderer that never consumed the request', () => {
    expect(consumeQuitAndStopAllSessionsRequest(MAIN_WEB_CONTENTS_ID + 1)).toBe(false)

    quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID + 1)
    quitAfterRendererStoppedAllSessions(MAIN_WEB_CONTENTS_ID)

    expect(electron.quit).not.toHaveBeenCalled()
  })
})

describe('getSystemTrayOptions', () => {
  beforeEach(() => {
    Object.assign(state, { store: { getSettings: () => ({ appIcon: 'classic' }) } })
  })

  it('offers Quit and Stop All Sessions on a desktop app only', () => {
    state.isServeMode = false
    expect(getSystemTrayOptions()?.onQuitAndStopAllSessions).toBeTypeOf('function')

    state.isServeMode = true
    expect(getSystemTrayOptions()?.onQuitAndStopAllSessions).toBeUndefined()
  })
})
