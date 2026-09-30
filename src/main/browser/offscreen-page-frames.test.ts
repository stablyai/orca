import { describe, expect, it, vi } from 'vitest'
import { createOffscreenPageFrames } from './offscreen-page-frames'

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

// A page with one cross-site iframe whose content box starts at (10, 20) and is 100 px square.
function fakePage() {
  const listeners = new Set<Listener>()
  const inFrame = (x: unknown, y: unknown) =>
    typeof x === 'number' && typeof y === 'number' && x >= 10 && x < 110 && y >= 20 && y < 120
  const reply = (method: string, params: Record<string, unknown>, sessionId?: string): unknown => {
    if (method === 'DOM.getNodeForLocation') {
      return { backendNodeId: !sessionId && inFrame(params.x, params.y) ? 7 : 1 }
    }
    if (method === 'DOM.describeNode') {
      return { node: params.backendNodeId === 7 ? { frameId: 'F1' } : {} }
    }
    if (method === 'DOM.getBoxModel') {
      return { model: { content: [10, 20, 110, 20, 110, 120, 10, 120] } }
    }
    return {}
  }
  const session = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      reply(method, params, sessionId)
    ),
    onMessage: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: vi.fn()
  }
  const frames = createOffscreenPageFrames(session, () => [['Page.enable']])
  const message = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener(method, params)
    }
  }
  const attachFrame = () =>
    message('Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', targetId: 'F1' }
    })
  const mouseSends = () =>
    session.send.mock.calls
      .filter(([method]) => method === 'Input.dispatchMouseEvent')
      .map(([, params, sessionId]) => [sessionId, params?.type, params?.x, params?.y])
  const move = (x: number, y: number, buttons = 0) =>
    frames.sendMouse({ type: 'mouseMoved', x, y, buttons, button: 'none' })
  return { session, frames, message, attachFrame, mouseSends, move }
}

describe('createOffscreenPageFrames', () => {
  it('sets up each attached iframe target like the page', () => {
    const { session, attachFrame } = fakePage()
    attachFrame()
    expect(session.send.mock.calls.map(([method, , sessionId]) => [method, sessionId])).toEqual([
      ['Target.setAutoAttach', 'S1'],
      ['Page.enable', 'S1']
    ])
  })

  it('sends the page its own input without hit testing while it has no iframe targets', async () => {
    const { session, move } = fakePage()
    await move(50, 50)
    expect(session.send.mock.calls).toEqual([
      [
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: 50, y: 50, buttons: 0, button: 'none' },
        undefined
      ]
    ])
  })

  it('routes into the iframe in its own coordinates and moves hover between frames', async () => {
    const { attachFrame, mouseSends, move } = fakePage()
    attachFrame()
    await move(5, 5)
    await move(30, 50)
    await move(40, 60)
    await move(200, 200)
    expect(mouseSends()).toEqual([
      [undefined, 'mouseMoved', 5, 5],
      // The page sees the pointer reach the iframe element, then the iframe takes over.
      [undefined, 'mouseMoved', 30, 50],
      ['S1', 'mouseMoved', 20, 30],
      ['S1', 'mouseMoved', 30, 40],
      ['S1', 'mouseMoved', -1, -1],
      [undefined, 'mouseMoved', 200, 200]
    ])
  })

  it('keeps a press in the iframe until every button is up', async () => {
    const { frames, attachFrame, mouseSends, move } = fakePage()
    attachFrame()
    await frames.sendMouse({ type: 'mousePressed', x: 30, y: 50, buttons: 1, button: 'left' })
    await move(200, 200, 1)
    await frames.sendMouse({ type: 'mouseReleased', x: 200, y: 200, buttons: 0, button: 'left' })
    await move(200, 200)
    expect(mouseSends().slice(1)).toEqual([
      ['S1', 'mousePressed', 20, 30],
      ['S1', 'mouseMoved', 190, 180],
      ['S1', 'mouseReleased', 190, 180],
      ['S1', 'mouseMoved', -1, -1],
      [undefined, 'mouseMoved', 200, 200]
    ])
  })

  it('issues later input only after earlier input was issued', async () => {
    const { session, frames, attachFrame, move } = fakePage()
    attachFrame()
    const moved = move(30, 50)
    const keyed = frames.inOrder(() => ({ reply: session.send('Input.dispatchKeyEvent') }))
    await Promise.all([moved, keyed])
    const methods = session.send.mock.calls.map(([method]) => method)
    expect(methods.indexOf('Input.dispatchKeyEvent')).toBeGreaterThan(
      methods.lastIndexOf('Input.dispatchMouseEvent')
    )
  })

  it('holds later input until the frame a press went to has answered once more', async () => {
    const { session, frames, attachFrame } = fakePage()
    attachFrame()
    await frames.sendMouse({ type: 'mousePressed', x: 30, y: 50, buttons: 1, button: 'left' })
    await frames.inOrder(() => ({ reply: session.send('Input.dispatchKeyEvent') }))
    const calls = session.send.mock.calls.map(([method, params, sessionId]) => [
      method,
      params?.x,
      sessionId
    ])
    const pressed = calls.findIndex(([method]) => method === 'Input.dispatchMouseEvent')
    expect(calls.slice(pressed + 1)).toEqual([
      ['Input.dispatchMouseEvent', 20, 'S1'],
      ['DOM.getNodeForLocation', 0, 'S1'],
      ['Input.dispatchKeyEvent', undefined, undefined]
    ])
  })

  it('forgets an iframe target once it detaches', async () => {
    const { frames, message, attachFrame } = fakePage()
    attachFrame()
    expect(await frames.locate(30, 50)).toEqual({ sessionId: 'S1', x: 20, y: 30 })
    message('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(await frames.locate(30, 50)).toEqual({ x: 30, y: 50 })
  })
})
