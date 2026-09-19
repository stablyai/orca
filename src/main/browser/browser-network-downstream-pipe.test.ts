import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { pipeBrowserNetworkDestinationToSocket } from './browser-network-downstream-pipe'

function fixture() {
  const settleRead = vi.fn()
  const upstream = Object.assign(new PassThrough(), { settleRead })
  const receipts: ((error?: Error | null) => void)[] = []
  const downstream = Object.assign(new EventEmitter(), {
    write: vi.fn((_bytes: Buffer, callback: (error?: Error | null) => void) => {
      receipts.push(callback)
      return false
    }),
    end: vi.fn()
  })
  pipeBrowserNetworkDestinationToSocket(upstream, downstream as unknown as Socket)
  return { upstream, downstream, receipts, settleRead }
}

it('acknowledges consumption only after the downstream write succeeds', () => {
  const f = fixture()
  f.upstream.emit('data', Buffer.from('reply'))
  expect(f.settleRead).not.toHaveBeenCalled()
  expect(f.upstream.isPaused()).toBe(true)
  f.receipts[0]()
  expect(f.settleRead).toHaveBeenCalledExactlyOnceWith(5)
  f.downstream.emit('drain')
  expect(f.upstream.isPaused()).toBe(false)
  f.upstream.destroy()
})

it('never reports a failed downstream write as consumed', () => {
  const f = fixture()
  f.upstream.emit('data', Buffer.from('reply'))
  f.receipts[0](new Error('destination closed'))
  expect(f.settleRead).not.toHaveBeenCalled()
  f.upstream.destroy()
})

it('does not turn upstream end into acknowledgment of pending downstream writes', () => {
  const f = fixture()
  f.upstream.emit('data', Buffer.from('reply'))
  f.upstream.emit('end')
  expect(f.downstream.end).toHaveBeenCalledOnce()
  expect(f.settleRead).not.toHaveBeenCalled()
  f.receipts[0]()
  expect(f.settleRead).toHaveBeenCalledExactlyOnceWith(5)
  f.upstream.destroy()
})
