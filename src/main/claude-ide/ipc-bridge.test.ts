import { describe, it, expect, vi } from 'vitest'
import { createIpcBridge } from './ipc-bridge'

describe('createIpcBridge', () => {
  it('openDiff resolves with the verdict the renderer reports', async () => {
    const send = vi.fn()
    const bridge = createIpcBridge('wt-a', send)
    const promise = bridge.openDiff({ oldPath: '/a', newPath: '/a', newContents: 'x' })
    const reqId = send.mock.calls[0][1].requestId
    bridge.resolvePending(reqId, 'reject')
    await expect(promise).resolves.toBe('reject')
  })

  it('closing the diff tab resolves reject (never hangs)', async () => {
    const bridge = createIpcBridge('wt-a', vi.fn())
    const promise = bridge.openDiff({ oldPath: '/a', newPath: '/a', newContents: 'x' })
    bridge.rejectAllPending()
    await expect(promise).resolves.toBe('reject')
  })

  it('data requests resolve with the value the renderer reports', async () => {
    const send = vi.fn()
    const bridge = createIpcBridge('wt-a', send)
    const promise = bridge.getWorkspaceFolders()
    const reqId = send.mock.calls[0][1].requestId
    bridge.resolveData(reqId, ['/w'])
    await expect(promise).resolves.toEqual(['/w'])
  })
})
