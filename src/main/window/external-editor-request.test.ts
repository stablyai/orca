import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return new EventEmitter()
})
vi.mock('electron', () => ({ ipcMain: ipc }))
vi.mock('./external-editor-file', () => ({
  authorizeExternalEditorFile: async (path: string) => path
}))

import { requestExternalEditor } from './external-editor-request'

/** Separate emitters make cross-window acknowledgement spoofing testable. */
function renderer() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>()
  })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
  return { window, webContents }
}

/** Replies must follow asynchronous path validation even with a mocked filesystem. */
async function start(wait = true) {
  const target = renderer()
  const controller = new AbortController()
  const result = requestExternalEditor(target.window, '/tmp/prompt.txt', wait, controller.signal)
  await Promise.resolve()
  const request = target.webContents.send.mock.calls[0]?.[1]
  if (!request || typeof request !== 'object' || !('requestId' in request)) {
    throw new Error('missing request')
  }
  const respond = (status: string, sender: unknown = target.webContents) => {
    ipc.emit('ui:externalEditorResponse', { sender }, { requestId: request.requestId, status })
  }
  return { ...target, result, respond, controller }
}

beforeEach(() => {
  ipc.removeAllListeners()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('external editor completion', () => {
  it('waits past the open deadline and ignores other renderers and premature close messages', async () => {
    const { result, respond, webContents } = await start()
    const settled = vi.fn()
    void result.then(settled)
    respond('closed')
    respond('opened')
    respond('closed', {})
    await vi.advanceTimersByTimeAsync(120_000)
    expect(settled).not.toHaveBeenCalled()
    respond('closed')
    await expect(result).resolves.toEqual({ filePath: '/tmp/prompt.txt', closed: true })
    expect(ipc.listenerCount('ui:externalEditorResponse')).toBe(0)
    expect(webContents.listenerCount('did-start-loading')).toBe(0)
  })

  it('without --wait returns only after the renderer acknowledges opening', async () => {
    const { result, respond } = await start(false)
    respond('opened')
    await expect(result).resolves.toMatchObject({ closed: false })
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-loading'])(
    'fails on renderer %s',
    async (event) => {
      const { result, respond, webContents } = await start()
      respond('opened')
      webContents.emit(event)
      await expect(result).rejects.toThrow('renderer_unavailable')
      expect(ipc.listenerCount('ui:externalEditorResponse')).toBe(0)
    }
  )

  it('fails if the window closes instead of confirming an editor close', async () => {
    const { result, window } = await start()
    window.emit('closed')
    await expect(result).rejects.toThrow('renderer_unavailable')
  })

  it('cleans up when the caller disconnects', async () => {
    const { result, controller, webContents } = await start()
    controller.abort()
    await expect(result).rejects.toThrow('cancelled')
    expect(ipc.listenerCount('ui:externalEditorResponse')).toBe(0)
    expect(webContents.send).toHaveBeenLastCalledWith('ui:externalEditorCancel', expect.any(String))
  })

  it('fails on a renderer that does not support the request', async () => {
    const { result } = await start()
    const rejected = expect(result).rejects.toThrow('did not acknowledge')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(ipc.listenerCount('ui:externalEditorResponse')).toBe(0)
  })

  it('keeps concurrent waiters independent', async () => {
    const first = await start()
    const second = await start()
    const settled = vi.fn()
    void second.result.then(settled)
    first.respond('opened')
    second.respond('opened')
    first.respond('closed')
    await first.result
    expect(settled).not.toHaveBeenCalled()
    second.respond('closed')
    await second.result
    expect(ipc.listenerCount('ui:externalEditorResponse')).toBe(0)
  })
})
