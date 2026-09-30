import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createOffscreenPageDragBridge } from './offscreen-page-drag'
import { createOffscreenPageFrames } from './offscreen-page-frames'

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

function fakePage() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => 1
  })
  const listeners = new Set<Listener>()
  const session = {
    send: vi.fn((_method: string, _params?: Record<string, unknown>, _sessionId?: string) =>
      Promise.resolve({})
    ),
    onMessage: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: vi.fn()
  }
  const message = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener(method, params)
    }
  }
  const frames = createOffscreenPageFrames(session, () => [])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the bridge touches.
  const bridge = createOffscreenPageDragBridge(session, frames, contents as never)
  const dragEvents = () =>
    session.send.mock.calls
      .filter(([method]) => method === 'Input.dispatchDragEvent')
      .map(([, params]) => params)
  return { contents, listeners, message, frames, bridge, dragEvents }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createOffscreenPageDragBridge', () => {
  it('replays pointer input after an intercepted drag as enter, over and drop', async () => {
    const { contents, message, dragEvents } = fakePage()
    const data = { items: [{ mimeType: 'text/plain', data: 'x' }], dragOperationsMask: 1 }
    contents.emit('input-event', {}, { type: 'mouseMove', x: 1, y: 1 })
    expect(dragEvents()).toEqual([])

    message('Input.dragIntercepted', { data })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 10, y: 20 })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 30, y: 40 })
    contents.emit('input-event', {}, { type: 'mouseUp', x: 30, y: 40 })
    contents.emit('input-event', {}, { type: 'mouseMove', x: 50, y: 60 })
    await settle()

    expect(dragEvents()).toEqual([
      { type: 'dragEnter', x: 10, y: 20, data },
      { type: 'dragOver', x: 10, y: 20, data },
      { type: 'dragOver', x: 30, y: 40, data },
      { type: 'drop', x: 30, y: 40, data }
    ])
  })

  it('cancels the drag when the pointer leaves the page or Escape is pressed', async () => {
    const { contents, message, dragEvents } = fakePage()
    message('Input.dragIntercepted', { data: {} })
    contents.emit('input-event', {}, { type: 'mouseLeave', x: 5, y: 5 })
    message('Input.dragIntercepted', { data: {} })
    contents.emit('input-event', {}, { type: 'rawKeyDown', key: 'Escape' })
    await settle()
    expect(dragEvents().map((event) => Reflect.get(Object(event), 'type'))).toEqual([
      'dragCancel',
      'dragCancel'
    ])
  })

  it('drops OS files as one enter, over, drop sequence at the drop point', async () => {
    const { bridge, dragEvents } = fakePage()
    await bridge.dropFiles({ x: 10.5, y: 20.5, files: ['/tmp/a.txt'] })
    const data = { items: [], files: ['/tmp/a.txt'], dragOperationsMask: 1 }
    expect(dragEvents()).toEqual([
      { type: 'dragEnter', x: 10.5, y: 20.5, data },
      { type: 'dragOver', x: 10.5, y: 20.5, data },
      { type: 'drop', x: 10.5, y: 20.5, data }
    ])
  })

  it('stops listening on dispose', () => {
    const { contents, listeners, frames, bridge } = fakePage()
    bridge.dispose()
    frames.dispose()
    expect(listeners.size).toBe(0)
    expect(contents.listenerCount('input-event')).toBe(0)
  })
})
