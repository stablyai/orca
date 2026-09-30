import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { sendDebuggerCommand } = vi.hoisted(() => ({
  sendDebuggerCommand: vi.fn((_debugger: unknown, _method: string, _params?: unknown) =>
    Promise.resolve({})
  )
}))
vi.mock('./browser-screencast-debugger-command', () => ({ sendDebuggerCommand }))

import { createOffscreenPageCdpSession } from './offscreen-page-cdp-session'

function fakePage(acquire = vi.fn(() => ({ release: vi.fn() }))) {
  sendDebuggerCommand.mockClear()
  const contents = Object.assign(new EventEmitter(), {
    debugger: new EventEmitter(),
    isDestroyed: () => false
  })
  const setup = vi.fn(() => [['Page.enable'] as const])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the session touches.
  const session = createOffscreenPageCdpSession(contents as never, setup, acquire as never)
  const methods = () => sendDebuggerCommand.mock.calls.map(([, method]) => method)
  return { contents, acquire, setup, session, methods }
}

describe('createOffscreenPageCdpSession', () => {
  it('attaches and runs setup at once, then sends commands on the same lease', async () => {
    const { acquire, session, methods } = fakePage()
    await expect(session.send('Input.insertText', { text: 'a' })).resolves.toEqual({})
    expect(acquire).toHaveBeenCalledOnce()
    expect(methods()).toEqual(['Page.enable', 'Input.insertText'])
  })

  it('re-attaches and replays setup after the debugger detaches', () => {
    const lease = { release: vi.fn() }
    const { contents, acquire, methods } = fakePage(vi.fn(() => lease))
    contents.debugger.emit('detach')
    expect(lease.release).toHaveBeenCalledOnce()
    contents.emit('input-event')
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(methods()).toEqual(['Page.enable', 'Page.enable'])
  })

  it('resolves undefined while no debugger can be had', async () => {
    const { session } = fakePage(
      vi.fn(() => {
        throw new Error('attached elsewhere')
      })
    )
    await expect(session.send('Input.insertText')).resolves.toBeUndefined()
  })

  it('fans debugger messages out to listeners until dispose', () => {
    const lease = { release: vi.fn() }
    const { contents, session } = fakePage(vi.fn(() => lease))
    const listener = vi.fn()
    session.onMessage(listener)
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 3 })
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 5 }, 'S1')
    session.dispose()
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 4 })
    expect(listener.mock.calls).toEqual([
      ['Page.fileChooserOpened', { backendNodeId: 3 }, undefined],
      ['Page.fileChooserOpened', { backendNodeId: 5 }, 'S1']
    ])
    expect(lease.release).toHaveBeenCalledOnce()
    expect(contents.listenerCount('input-event')).toBe(0)
  })
})
