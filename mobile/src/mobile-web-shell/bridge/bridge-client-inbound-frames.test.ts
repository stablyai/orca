import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { pageStorageEntriesForInit } from '../page-storage-keys'
import { subscribeMirroredKey } from '../../storage/mirrored-storage-keys'
import pageAsyncStorage, { publishPageStorage } from './page-async-storage'
import {
  createPageClient as createPage,
  idOf,
  INIT,
  readError
} from './bridge-page-client-test-harness'

const resources = new Set<ReturnType<typeof createPage>>()
function createPageClient(...args: Parameters<typeof createPage>): ReturnType<typeof createPage> {
  const resource = createPage(...args)
  resources.add(resource)
  return resource
}
function closeResources(): void {
  for (const resource of resources) {
    resource.client.close()
  }
  resources.clear()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  closeResources()
  vi.useRealTimers()
})

describe('bridge client refusals and send failures', () => {
  it('applies storage frames once and notifies mirrored-key listeners', async () => {
    const page = createPageClient()
    publishPageStorage({ 'orca:markdownTextScale': '1' }, () => true, 'host-a', '/h/host-a')
    const listener = vi.fn()
    const unsubscribe = subscribeMirroredKey('orca:markdownTextScale', listener)
    page.start()
    const frame = {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'storage',
      key: 'orca:markdownTextScale',
      value: '1.5'
    }
    page.deliver(frame)
    page.deliver(frame)
    page.deliver({ ...frame, key: 'orca:pins:other-host' })
    expect(await pageAsyncStorage.getItem(frame.key)).toBe('1.5')
    expect(listener).toHaveBeenCalledExactlyOnceWith('1.5')
    unsubscribe()
  })
  it('initializes across page versions and drops storage keys the page does not know', () => {
    const held = { 'orca:terminalTextScale': '1', 'orca:markdownTextScale': '1.5' }
    for (const pageVersion of [undefined, 1, 2]) {
      const { entries } = pageStorageEntriesForInit(held, pageVersion)
      expect(entries).toEqual(pageVersion === 2 ? held : { 'orca:terminalTextScale': '1' })
      const page = createPageClient()
      const ready = vi.fn()
      page.client.onReady(ready)
      page.deliver({
        ...INIT,
        storage: { ...entries, 'orca:futurePreference': 'new value' },
        storageOversize: ['orca:futureOversizedPreference']
      })
      expect(ready).toHaveBeenCalledOnce()
      expect(page.client.getShellSession()?.storage).toEqual(entries)
      expect(page.client.getShellSession()?.storageOversize).toEqual([])
      expect(page.diagnostics).toEqual([])
    }
  })

  it('reports a frame its own reader will not take, and changes nothing', () => {
    const page = createPageClient()
    page.start()
    page.deliverRaw('{ not json')
    page.deliverRaw(JSON.stringify({ v: 99, type: 'state' }))
    page.deliverRaw(`"${'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES)}"`)
    expect(page.diagnostics).toEqual([
      { kind: 'refused', refusal: 'malformed-json' },
      { kind: 'refused', refusal: 'unrecognised-message' },
      { kind: 'refused', refusal: 'oversized' }
    ])
    expect(page.client.getState()).toBe('connected')
  })

  it('settles the request a reply it could not read was answering, on the same turn', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    // `{ ok: true }` with no `result`: refused by this reader and by `isRpcResponse` alike.
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: idOf(page, 0),
      payload: { id: 'frame-1', ok: true }
    })
    // Settle immediately; waiting for a timer lets consumers render without their answer.
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeReplyRefusedError')
    expect(readError(error).message).toContain('unrecognised-message')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(page.diagnostics).toContainEqual({
      kind: 'refused',
      refusal: 'unrecognised-message'
    })
  })

  it('ends the stream an event it could not read belonged to, and cancels it at the shell', () => {
    const page = createPageClient()
    page.start()
    const ended: unknown[] = []
    page.client.subscribe('terminal.stream', { terminal: 't1' }, (result) => {
      ended.push(result)
    })
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id: idOf(page, 0), seq: -1 })
    expect(page.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'refused',
      'stream-failed'
    ])
    expect(ended).toHaveLength(1)
    // Cancel at the shell too: its unacked-frame backstop never releases a stream that has gone quiet.
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'cancel',
      id: idOf(page, 0),
      target: 'subscription'
    })
  })

  it('settles distinct retired streams without posting cancel', () => {
    const page = createPageClient()
    page.start()
    const ended: unknown[] = []
    const failed: unknown[] = []
    page.client.subscribe('terminal.stream', { terminal: 't1' }, (value) => ended.push(value))
    page.client.subscribe('terminal.stream', { terminal: 't2' }, (value) => failed.push(value))
    const end = { v: BRIDGE_PROTOCOL_VERSION, type: 'end', id: idOf(page, 0), reason: 'closed' }
    const error = {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      id: idOf(page, 1),
      error: { category: 'Error', message: 'gone', isRpcDeliveryUnknown: false }
    }
    const before = page.frames().length
    page.deliver(end)
    page.deliver(error)
    expect(ended).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('closed') })
    ])
    expect(failed).toEqual([expect.objectContaining({ type: 'error', message: 'gone' })])
    page.deliver(end)
    page.deliver(error)
    expect(ended).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(page.frames()).toHaveLength(before)
    expect(page.diagnostics.filter((entry) => entry.kind === 'refused')).toEqual([])
  })

  it('cannot settle a reply whose frame it never parsed, and nothing on the page can', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    let settled = false
    void answer.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    // Oversized/malformed JSON yields no salvageable id; only close/replacement can release its exchange. A conforming host instead chunks or sends an error within caps.
    page.deliverRaw(`{"v":1,"type":"reply","id":"${idOf(page, 0)}",`)
    page.deliverRaw(`"${'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES)}"`)
    await Promise.resolve()
    expect(page.diagnostics).toEqual([
      { kind: 'refused', refusal: 'malformed-json' },
      { kind: 'refused', refusal: 'oversized' }
    ])
    expect(settled).toBe(false)
    page.client.close()
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeClientClosedError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
  })

  it('leaves a refused frame that names no open exchange to the diagnostic alone', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: 'ZZZZZZZZZZZZZZZZZZZZZZ',
      payload: { id: 'frame-1', ok: true }
    })
    expect(page.diagnostics).toEqual([{ kind: 'refused', refusal: 'unrecognised-message' }])
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: idOf(page, 0),
      payload: { id: 'frame-1', ok: true, result: 7, _meta: { runtimeId: 'runtime-a' } }
    })
    await expect(answer).resolves.toEqual({
      id: 'frame-1',
      ok: true,
      result: 7,
      _meta: { runtimeId: 'runtime-a' }
    })
  })

  it('fails a request whose frame never left the page, without the delivery mark', async () => {
    let live = true
    const page = createPageClient({
      send: () => {
        if (!live) {
          throw new Error('the port is gone')
        }
      }
    })
    page.start()
    live = false
    const answer = page.client.sendRequest('worktree.ps')
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeSendFailedError')
    expect(isRpcDeliveryUnknown(error)).toBe(false)
    expect(page.diagnostics.at(-1)).toEqual({
      kind: 'send-failed',
      error: expect.any(Error)
    })
  })
})
