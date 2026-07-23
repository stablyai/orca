import { describe, expect, it, vi } from 'vitest'
import {
  appendPtyDeliveryCredit,
  MAX_PENDING_PTY_DELIVERY_CREDIT_SPANS,
  MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS,
  MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS_PER_PTY,
  MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES,
  MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES,
  PtyRendererDeliveryCreditLedger,
  settlePtyDeliveryCredit,
  takePtyDeliveryCredit
} from './pty-renderer-delivery-credit'

function makeCredit(charCount: number) {
  return { charCount, acknowledge: vi.fn() }
}

describe('PTY renderer delivery credit', () => {
  it('splits queued provider credit without settling bytes left for a later renderer chunk', () => {
    const first = makeCredit(5)
    const second = makeCredit(7)
    const spans = appendPtyDeliveryCredit(appendPtyDeliveryCredit(undefined, first), second)

    const taken = takePtyDeliveryCredit(spans, 8)
    settlePtyDeliveryCredit(taken)

    expect(first.acknowledge).toHaveBeenCalledWith(5)
    expect(second.acknowledge).toHaveBeenCalledWith(3)
    expect(spans).toEqual([{ credit: second, chars: 4 }])
  })

  it('settles explicit provider owners and legacy fallback spans in renderer order', () => {
    const first = makeCredit(5)
    const second = makeCredit(4)
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()

    ledger.recordSent('pty-1', 5, [{ credit: first, chars: 5 }], acknowledgeFallback)
    ledger.recordSent('pty-1', 3, undefined, acknowledgeFallback)
    ledger.recordSent('pty-1', 4, [{ credit: second, chars: 4 }], acknowledgeFallback)
    ledger.acknowledge('pty-1', 7, acknowledgeFallback)
    ledger.acknowledge('pty-1', 2, acknowledgeFallback)
    ledger.acknowledge('pty-1', 3, acknowledgeFallback)

    expect(first.acknowledge).toHaveBeenCalledWith(5)
    expect(second.acknowledge.mock.calls).toEqual([[1], [3]])
    expect(acknowledgeFallback.mock.calls).toEqual([[2], [1]])
  })

  it('writes off every captured owner while keeping PTY fallback routing separate', () => {
    const first = makeCredit(4)
    const second = makeCredit(6)
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()

    ledger.recordSent('pty-1', 4, [{ credit: first, chars: 4 }], acknowledgeFallback)
    ledger.recordSent('pty-2', 2, undefined, acknowledgeFallback)
    ledger.recordSent('pty-3', 6, [{ credit: second, chars: 6 }], acknowledgeFallback)
    ledger.writeOffAll(acknowledgeFallback)

    expect(first.acknowledge).toHaveBeenCalledWith(4)
    expect(second.acknowledge).toHaveBeenCalledWith(6)
    expect(acknowledgeFallback).toHaveBeenCalledOnce()
    expect(acknowledgeFallback).toHaveBeenCalledWith('pty-2', 2)
  })

  it('abandons an exited PTY without crediting a replacement owner', () => {
    const exited = makeCredit(4)
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()
    ledger.recordSent('reused-id', 4, [{ credit: exited, chars: 4 }], acknowledgeFallback)

    ledger.abandon('reused-id')
    ledger.acknowledge('reused-id', 4, acknowledgeFallback)

    expect(exited.acknowledge).not.toHaveBeenCalled()
    expect(acknowledgeFallback).not.toHaveBeenCalled()
  })

  it('collapses one-byte pending credit floods into already-settled metadata', () => {
    const total = MAX_PENDING_PTY_DELIVERY_CREDIT_SPANS + 100
    const credits = Array.from({ length: total }, () => makeCredit(1))
    let spans
    for (const credit of credits) {
      spans = appendPtyDeliveryCredit(spans, credit)
    }

    expect(spans).toEqual([{ chars: total, settled: true }])
    expect(credits.every((credit) => credit.acknowledge.mock.calls.length === 1)).toBe(true)

    const ledger = new PtyRendererDeliveryCreditLedger()
    const acknowledgeFallback = vi.fn()
    const sent = takePtyDeliveryCredit(spans, total)
    ledger.recordSent('pty-tiny', total, sent, acknowledgeFallback)
    ledger.acknowledge('pty-tiny', total, acknowledgeFallback)

    expect(acknowledgeFallback).not.toHaveBeenCalled()
    expect(credits.every((credit) => credit.acknowledge.mock.calls.length === 1)).toBe(true)
  })

  it('bounds per-PTY in-flight credit closures and settles each exactly once', () => {
    const total = MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS_PER_PTY + 100
    const credits = Array.from({ length: total }, () => makeCredit(1))
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()

    for (const credit of credits) {
      ledger.recordSent('pty-tiny', 1, [{ credit, chars: 1 }], acknowledgeFallback)
    }

    const state = (Reflect.get(ledger, 'inFlightByPty') as Map<string, { spans: unknown[] }>).get(
      'pty-tiny'
    )
    expect(state?.spans.length).toBeLessThanOrEqual(MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS_PER_PTY)
    ledger.acknowledge('pty-tiny', total, acknowledgeFallback)

    expect(acknowledgeFallback).not.toHaveBeenCalled()
    expect(credits.every((credit) => credit.acknowledge.mock.calls.length === 1)).toBe(true)
  })

  it('bounds aggregate in-flight credit spans across PTYs', () => {
    let acknowledged = 0
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()
    const total = MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS + 100

    for (let index = 0; index < total; index += 1) {
      const credit = {
        charCount: 1,
        acknowledge: (chars: number) => {
          acknowledged += chars
        }
      }
      ledger.recordSent(`pty-${index % 8}`, 1, [{ credit, chars: 1 }], acknowledgeFallback)
    }

    expect(Reflect.get(ledger, 'retainedSpanCount')).toBeLessThanOrEqual(
      MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS
    )
    ledger.writeOffAll(acknowledgeFallback)
    expect(acknowledged).toBe(total)
    expect(acknowledgeFallback).not.toHaveBeenCalled()
  })

  it('bounds unique in-flight IDs and settles evicted credit exactly once', () => {
    const credits = Array.from({ length: MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES + 50 }, () =>
      makeCredit(1)
    )
    const acknowledgeFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()

    for (const [index, credit] of credits.entries()) {
      ledger.recordSent(`pty-${index}`, 1, [{ credit, chars: 1 }], acknowledgeFallback)
    }

    const states = Reflect.get(ledger, 'inFlightByPty') as Map<string, unknown>
    expect(states.size).toBe(MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES)
    expect(states.has('pty-0')).toBe(false)
    ledger.writeOffAll(acknowledgeFallback)
    expect(credits.every((credit) => credit.acknowledge.mock.calls.length === 1)).toBe(true)
    expect(acknowledgeFallback).not.toHaveBeenCalled()
  })

  it('bounds aggregate in-flight ID bytes and settles fallback before eviction', () => {
    const id = 'x'.repeat(MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES)
    const settleFallback = vi.fn()
    const ledger = new PtyRendererDeliveryCreditLedger()

    ledger.recordSent(id, 3, undefined, settleFallback)
    ledger.recordSent('extra', 2, undefined, settleFallback)

    const states = Reflect.get(ledger, 'inFlightByPty') as Map<string, unknown>
    expect(states.size).toBe(1)
    expect(states.has(id)).toBe(false)
    expect(settleFallback).toHaveBeenCalledOnce()
    expect(settleFallback).toHaveBeenCalledWith(3)
    ledger.acknowledge(id, 3, settleFallback)
    expect(settleFallback).toHaveBeenCalledOnce()
  })
})
