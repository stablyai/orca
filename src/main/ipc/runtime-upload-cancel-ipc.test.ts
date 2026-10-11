import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<
  string,
  (event: { sender: EventEmitter & { id: number } }, args: unknown) => unknown
>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: EventEmitter & { id: number } }, args: unknown) => unknown
    ) => handlers.set(channel, handler)
  }
}))

import { registerRuntimeUploadCancelHandlers } from './runtime-upload-cancel-ipc'
import {
  forgetRuntimeUploadCancellation,
  isUploadCancelled,
  scopeRuntimeUploadId
} from './runtime-upload-cancellation'

registerRuntimeUploadCancelHandlers()

function renderer(id: number): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id })
}

function invoke(channel: string, sender: EventEmitter & { id: number }, args: unknown): unknown {
  return handlers.get(channel)!({ sender }, args)
}

afterEach(() => {
  for (const senderId of [1, 2, 3]) {
    for (const uploadId of ['u', 'a', 'b']) {
      forgetRuntimeUploadCancellation(scopeRuntimeUploadId(senderId, uploadId))
    }
  }
})

describe('runtime upload cancel IPC', () => {
  it('records and releases a cancel only for the renderer that sent it', () => {
    const first = renderer(1)
    invoke('fs:cancelRuntimeUpload', first, { uploadId: 'u' })

    expect(isUploadCancelled(scopeRuntimeUploadId(1, 'u'))).toBe(true)
    expect(isUploadCancelled(scopeRuntimeUploadId(2, 'u'))).toBe(false)

    invoke('fs:releaseRuntimeUpload', first, { uploadId: 'u' })
    expect(isUploadCancelled(scopeRuntimeUploadId(1, 'u'))).toBe(false)
  })

  it('rejects malformed upload ids without changing cancellation state', () => {
    const sender = renderer(1)
    for (const args of [
      null,
      undefined,
      {},
      { uploadId: '' },
      { uploadId: '  ' },
      { uploadId: 3 }
    ]) {
      expect(() => invoke('fs:cancelRuntimeUpload', sender, args)).not.toThrow()
      expect(() => invoke('fs:releaseRuntimeUpload', sender, args)).not.toThrow()
    }

    expect(isUploadCancelled(scopeRuntimeUploadId(1, ''))).toBe(false)
    expect(isUploadCancelled(scopeRuntimeUploadId(1, '  '))).toBe(false)
  })

  it('drops cancels when the renderer goes away and re-arms after reload', () => {
    const sender = renderer(3)
    invoke('fs:cancelRuntimeUpload', sender, { uploadId: 'a' })
    sender.emit('did-navigate')
    expect(isUploadCancelled(scopeRuntimeUploadId(3, 'a'))).toBe(false)

    invoke('fs:cancelRuntimeUpload', sender, { uploadId: 'b' })
    sender.emit('render-process-gone')
    expect(isUploadCancelled(scopeRuntimeUploadId(3, 'b'))).toBe(false)
  })
})
