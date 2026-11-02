// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { handleMsg } from './host-message-router'
import { notify } from './host-notify'
import { dispatcherShouldBlockSurface } from './tap-dispatch'
import { scheduleDocumentFrame } from './document-frame-registry'
import { attachSurfaceEventHandlers } from './surface-touch-gestures'
import { terminalDocumentDouble } from './document-terminal-double.test-support'

afterEach(() => vi.restoreAllMocks())

describe('inactive terminal interaction ownership', () => {
  it.each(['suspension', 'touchcancel'] as const)(
    'restores the resting transform when %s interrupts a pinch',
    (interruption) => {
      const postToHost = vi.fn()
      const scope = createTerminalDocumentScope({ postToHost })
      const surface = document.createElement('div')
      document.body.appendChild(surface)
      scope.surface = surface
      scope.term = terminalDocumentDouble().terminal
      attachSurfaceEventHandlers(scope, surface)
      const touch = (type: string, xs: number[]) => {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'touches', {
          value: xs.map((clientX, identifier) => ({
            identifier,
            clientX,
            clientY: 10,
            target: surface
          }))
        })
        surface.dispatchEvent(event)
      }

      touch('touchstart', [10, 30])
      touch('touchmove', [10, 40])
      expect(surface.style.transform).toContain('scale(1.5)')

      if (interruption === 'suspension') {
        handleMsg(scope, { type: 'set-interaction-active', active: false })
        handleMsg(scope, { type: 'set-interaction-active', active: true })
      } else {
        touch('touchcancel', [])
      }
      touch('touchend', [])

      expect(surface.style.transform).toBe('translate(0px,0px) scale(1)')
      expect(scope.term.options.fontSize).toBe(13)
      expect(postToHost.mock.calls.some(([message]) => message.type === 'font-scale-changed')).toBe(
        false
      )
      touch('touchstart', [10, 30])
      touch('touchmove', [10, 40])
      expect(surface.style.transform).toContain('scale(1.5)')
      surface.remove()
    }
  )

  it('keeps interrupted and inactive moves away from xterm', () => {
    const scope = createTerminalDocumentScope()
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    scope.surface = surface
    scope.term = terminalDocumentDouble().terminal
    attachSurfaceEventHandlers(scope, surface)
    const reachedDocument: string[] = []
    const onDocument = (e: Event) => reachedDocument.push(e.type)
    document.addEventListener('touchmove', onDocument)
    document.addEventListener('wheel', onDocument)
    const move = () => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', {
        value: [{ identifier: 0, clientX: 10, clientY: 10, target: surface }]
      })
      surface.dispatchEvent(event)
    }

    handleMsg(scope, { type: 'set-interaction-active', active: false })
    move()
    surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }))
    handleMsg(scope, { type: 'set-interaction-active', active: true })
    move()

    expect(reachedDocument).toEqual([])
    document.removeEventListener('touchmove', onDocument)
    document.removeEventListener('wheel', onDocument)
    surface.remove()
  })

  it('releases cancelled gesture frames across repeated hide/show cycles', () => {
    const scope = createTerminalDocumentScope()
    let nextFrame = 0
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => ++nextFrame)
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    const paint = vi.fn()
    const paintFrame = scheduleDocumentFrame(scope, paint)
    for (let cycle = 0; cycle < 1000; cycle++) {
      scope.touchGesture.momentumId = scheduleDocumentFrame(scope, () => {})
      scope.normalScrollFrameId = scheduleDocumentFrame(scope, () => {})
      handleMsg(scope, { type: 'set-interaction-active', active: false })
      handleMsg(scope, { type: 'set-interaction-active', active: true })
    }
    expect(scope.scheduledFrames).toEqual([paintFrame])
    expect(cancel).toHaveBeenCalledTimes(2000)
    expect(paint).not.toHaveBeenCalled()
    expect(scope.framesStopped).toBe(false)
  })

  it('cancels pending motion when hidden and admits a new gesture when shown again', () => {
    const scope = createTerminalDocumentScope()
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    scope.touchGesture.momentumId = 10
    scope.normalScrollFrameId = 11
    scope.pendingNormalScrollDeltaY = 42
    scope.touchGesture.velY = 2
    scope.touchGesture.accumDelta = 9
    handleMsg(scope, { type: 'set-interaction-active', active: false })
    expect(cancel.mock.calls.flat()).toEqual(expect.arrayContaining([10, 11]))
    expect(scope.touchGesture.momentumId).toBeNull()
    expect(scope.pendingNormalScrollDeltaY).toBe(0)
    expect(scope.touchGesture.velY).toBe(0)
    expect(dispatcherShouldBlockSurface(scope)).toBe(true)
    handleMsg(scope, { type: 'set-interaction-active', active: true })
    expect(dispatcherShouldBlockSurface(scope)).toBe(false)
  })

  it('drops delayed gesture input while retaining terminal query replies and readiness', () => {
    const postToHost = vi.fn()
    const scope = createTerminalDocumentScope({ postToHost })
    handleMsg(scope, { type: 'set-interaction-active', active: false })
    notify(scope, { type: 'terminal-input', bytes: '\u001b[A' })
    notify(scope, { type: 'terminal-tap' })
    notify(scope, { type: 'terminal-data', bytes: '\u001b[1;1R' })
    notify(scope, { type: 'web-ready' })
    expect(postToHost.mock.calls.map(([message]) => message.type)).toEqual([
      'terminal-data',
      'web-ready'
    ])
    handleMsg(scope, { type: 'set-interaction-active', active: true })
    notify(scope, { type: 'terminal-input', bytes: '\u001b[A' })
    expect(postToHost).toHaveBeenLastCalledWith({ type: 'terminal-input', bytes: '\u001b[A' })
  })

  it('does not interpret an invalid activity value as a request to enable input', () => {
    const scope = createTerminalDocumentScope()
    handleMsg(scope, { type: 'set-interaction-active', active: false })
    handleMsg(scope, { type: 'set-interaction-active' })
    expect(scope.interactionActive).toBe(false)
  })
})
