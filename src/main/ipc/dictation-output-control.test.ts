import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, isTrustedUIRendererMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isTrustedUIRendererMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import { registerDictationOutputControlHandlers } from './dictation-output-control'
import type { DictationOutputControlService } from '../speech/dictation-output-control'

function getHandler(channel: string): (event: unknown, args?: unknown) => unknown {
  const registration = handleMock.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  )
  if (!registration) {
    throw new Error(`missing handler: ${channel}`)
  }
  return registration[1]
}

describe('registerDictationOutputControlHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    isTrustedUIRendererMock.mockReset()
    isTrustedUIRendererMock.mockReturnValue(true)
  })

  it('forwards capabilities from the service', async () => {
    const service = {
      getCapabilities: vi.fn(async () => ({
        canMuteOutput: true,
        canDuckOutput: true,
        canPauseMedia: false
      }))
    } as unknown as DictationOutputControlService

    registerDictationOutputControlHandlers(service)

    await expect(
      getHandler('dictationOutput:getCapabilities')({ sender: { id: 1 } })
    ).resolves.toEqual({
      canMuteOutput: true,
      canDuckOutput: true,
      canPauseMedia: false
    })
  })

  it('clamps renderer settings before applying output control', async () => {
    const service = {
      applyForSession: vi.fn(async () => undefined),
      getCapabilities: vi.fn()
    } as unknown as DictationOutputControlService

    registerDictationOutputControlHandlers(service)
    await getHandler('dictationOutput:apply')(
      { sender: { id: 7 } },
      {
        sessionId: 'abc',
        settings: { pauseMedia: 'yes', volumeMode: 'duck', duckedVolumePercent: 150 }
      }
    )

    expect(service.applyForSession).toHaveBeenCalledWith('7:abc', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 100
    })
  })

  it('keys restore ownership by sender id and session id', async () => {
    const service = {
      applyForSession: vi.fn(async () => undefined),
      restoreForSession: vi.fn(async () => undefined)
    } as unknown as DictationOutputControlService

    registerDictationOutputControlHandlers(service)
    await getHandler('dictationOutput:apply')(
      { sender: { id: 1 } },
      {
        sessionId: 'same',
        settings: { pauseMedia: false, volumeMode: 'mute', duckedVolumePercent: 20 }
      }
    )
    await getHandler('dictationOutput:restore')({ sender: { id: 2 } }, { sessionId: 'same' })

    expect(service.applyForSession).toHaveBeenCalledWith('1:same', expect.any(Object))
    expect(service.restoreForSession).toHaveBeenCalledWith('2:same')
  })

  it('rejects output control from untrusted renderers', async () => {
    const service = {
      applyForSession: vi.fn(async () => undefined)
    } as unknown as DictationOutputControlService
    isTrustedUIRendererMock.mockReturnValue(false)

    registerDictationOutputControlHandlers(service)

    await expect(
      getHandler('dictationOutput:apply')(
        { sender: { id: 7 } },
        {
          sessionId: 'abc',
          settings: { pauseMedia: false, volumeMode: 'mute', duckedVolumePercent: 20 }
        }
      )
    ).rejects.toThrow('Unauthorized dictation output IPC sender')
    expect(service.applyForSession).not.toHaveBeenCalled()
  })

  it('restores all sender-owned snapshots when the renderer is destroyed', async () => {
    const service = {
      applyForSession: vi.fn(async () => undefined),
      restoreForOwner: vi.fn(async () => undefined)
    } as unknown as DictationOutputControlService
    const sender = { id: 7, once: vi.fn() }

    registerDictationOutputControlHandlers(service)
    await getHandler('dictationOutput:apply')(
      { sender },
      {
        sessionId: 'abc',
        settings: { pauseMedia: false, volumeMode: 'mute', duckedVolumePercent: 20 }
      }
    )

    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    const onDestroyed = sender.once.mock.calls[0][1] as () => void
    const onRenderProcessGone = sender.once.mock.calls[1][1] as () => void
    onDestroyed()
    onRenderProcessGone()
    expect(service.restoreForOwner).toHaveBeenCalledTimes(1)
    expect(service.restoreForOwner).toHaveBeenCalledWith('7')
  })
})
