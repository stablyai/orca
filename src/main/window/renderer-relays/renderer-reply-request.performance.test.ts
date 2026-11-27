import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => {
  const holder: { main: EventEmitter | null } = { main: null }
  return holder
})
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  ipc.main = new Emitter()
  return { ipcMain: ipc.main }
})

import { requestRendererReply } from './renderer-reply-request'

function ipcMain(): EventEmitter {
  if (!ipc.main) {
    throw new Error('electron mock not loaded')
  }
  return ipc.main
}

/** A window whose renderer records each request it is sent. */
function fakeWindow() {
  const sent: string[] = []
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, payload: { requestId: string }) => {
      sent.push(payload.requestId)
    }
  })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
  return { window, webContents, sent }
}

it.each([100, 1_000])(
  'replies to %i concurrent requests are each routed once, not through every pending request',
  async (count) => {
    const { window, webContents, sent } = fakeWindow()
    const replies = Array.from({ length: count }, () =>
      requestRendererReply<{ requestId: string; ok: boolean }>(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper uses only isDestroyed, webContents and the closed event.
        window as never,
        {
          requestChannel: 'test:request',
          replyChannel: 'test:reply',
          payload: {},
          timeoutMs: 60_000,
          timeoutError: 'timeout'
        }
      )
    )
    // Each reply counts every read of its id: one per comparison a pending request makes.
    let idReads = 0
    const reply = (requestId: string, sender: EventEmitter = webContents) => {
      const payload = {
        ok: true,
        get requestId() {
          idReads += 1
          return requestId
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply channel's listener receives (event, payload); its event is read only for sender.
      ipcMain().emit('test:reply', { sender } as never, payload)
    }

    // A foreign sender's reply settles nothing.
    reply(sent[0], new EventEmitter())
    for (const requestId of sent) {
      reply(requestId)
    }
    const settled = await Promise.all(replies)
    expect(settled).toHaveLength(count)
    expect(idReads).toBeLessThanOrEqual(3 * (count + 1))
    // A late reply finds nothing to settle, and every route is released.
    reply(sent[0])
    expect(ipcMain().listenerCount('test:reply')).toBe(0)
  }
)
