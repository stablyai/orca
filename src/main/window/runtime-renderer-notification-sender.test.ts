import { describe, expect, it, vi } from 'vitest'
import { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'

type RendererSend = (channel: string, ...args: unknown[]) => void

function createSender(
  options: {
    send?: RendererSend
    windowDestroyed?: boolean
    webContentsDestroyed?: boolean
  } = {}
) {
  const send = options.send ?? vi.fn<RendererSend>()
  const onFailure = vi.fn()
  const warn = vi.fn()
  const sender = createRuntimeRendererNotificationSender({
    isWindowDestroyed: () => options.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options.webContentsDestroyed ?? false,
      send
    },
    onFailure,
    warn
  })
  return { sender, send, onFailure, warn }
}

describe('runtime renderer notification sender', () => {
  it('contains a disposed frame and suppresses repeated sends and warnings', () => {
    const failure = new Error('Render frame was disposed before WebFrameMain could be accessed')
    const fixture = createSender({
      send: vi.fn(() => {
        throw failure
      })
    })

    expect(fixture.sender.send('repos:changed')).toBe(false)
    expect(fixture.sender.send('worktrees:changed')).toBe(false)
    expect(fixture.sender.send('repos:changed')).toBe(false)

    expect(fixture.send).toHaveBeenCalledOnce()
    expect(fixture.warn).toHaveBeenCalledOnce()
    expect(fixture.onFailure).toHaveBeenCalledExactlyOnceWith('renderer-frame-unavailable')
  })

  it('pauses during a main-frame reload and resumes only after load finishes', () => {
    const fixture = createSender()

    fixture.sender.onMainFrameReloadStarted()
    expect(fixture.sender.send('repos:changed')).toBe(false)
    fixture.sender.onMainFrameLoadFinished()

    expect(fixture.sender.send('repos:changed')).toBe(true)
    expect(fixture.send).toHaveBeenCalledOnce()
    expect(fixture.onFailure).not.toHaveBeenCalled()
  })

  it('treats an absent or destroyed renderer as unavailable without throwing', () => {
    const missingWindow = createSender({ windowDestroyed: true })
    const missingWebContents = createSender({ webContentsDestroyed: true })

    expect(missingWindow.sender.send('repos:changed')).toBe(false)
    expect(missingWebContents.sender.send('repos:changed')).toBe(false)
    expect(missingWindow.onFailure).not.toHaveBeenCalled()
    expect(missingWebContents.onFailure).not.toHaveBeenCalled()
  })

  it('reports renderer process loss once per load generation', () => {
    const fixture = createSender()

    fixture.sender.onRendererProcessGone()
    fixture.sender.onRendererProcessGone()

    expect(fixture.warn).toHaveBeenCalledOnce()
    expect(fixture.onFailure).toHaveBeenCalledExactlyOnceWith('renderer-process-gone')
  })
})
