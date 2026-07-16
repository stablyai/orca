import { describe, expect, it, vi } from 'vitest'
import { registerSystemResumeBroadcast, SYSTEM_RESUMED_CHANNEL } from './system-resume-broadcast'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))

type ResumeListener = () => void

function createResumeSource() {
  const state: { listener: ResumeListener | null } = { listener: null }
  const source = {
    on: vi.fn((_event: 'resume', callback: ResumeListener) => {
      state.listener = callback
    }),
    off: vi.fn((_event: 'resume', _callback: ResumeListener) => {
      state.listener = null
    })
  }
  return { source, fireResume: () => state.listener?.() }
}

function createWindow(destroyed = false): {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn<(channel: string) => void>> }
} {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn<(channel: string) => void>() }
  }
}

describe('registerSystemResumeBroadcast', () => {
  it('broadcasts the resume channel to every live window', () => {
    const { source, fireResume } = createResumeSource()
    const liveWindow = createWindow()
    const destroyedWindow = createWindow(true)
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [liveWindow, destroyedWindow]
    })

    fireResume()

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(SYSTEM_RESUMED_CHANNEL)
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('stops broadcasting after unsubscribe', () => {
    const { source, fireResume } = createResumeSource()
    const window = createWindow()
    const unsubscribe = registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [window]
    })

    unsubscribe()
    fireResume()

    expect(source.off).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
