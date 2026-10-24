// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { handleMsg } from './host-message-router'
import { notify } from './host-notify'
import { dispatcherShouldBlockSurface } from './tap-dispatch'

afterEach(() => vi.restoreAllMocks())

describe('inactive terminal interaction ownership', () => {
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
    notify(scope, { type: 'terminal-query-reply', bytes: '\u001b[1;1R' })
    notify(scope, { type: 'web-ready' })
    expect(postToHost.mock.calls.map(([message]) => message.type)).toEqual([
      'terminal-query-reply',
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
