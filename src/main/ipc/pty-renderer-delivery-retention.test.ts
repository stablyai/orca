import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING_PTY_DATA_CHARS,
  MAX_PENDING_PTY_DATA_CREDIT_SPANS,
  MAX_PENDING_PTY_DATA_ID_BYTES,
  MAX_PENDING_PTY_DATA_STATES,
  MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_ID_BYTES,
  MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES,
  PendingPtyDataMap,
  PtyRendererDeliveryAccountingMap,
  PtyRendererDeliveryIdSet,
  settleRejectedPtyRendererDelivery
} from './pty-renderer-delivery-retention'

type Pending = {
  data: string
  creditSpans: number
}

function pendingMap(onRejected = vi.fn()) {
  return {
    map: new PendingPtyDataMap<Pending>(
      (pending) => ({ chars: pending.data.length, creditSpans: pending.creditSpans }),
      onRejected
    ),
    onRejected
  }
}

describe('PTY renderer delivery retention', () => {
  it('preserves ordinary pending updates and exact map bookkeeping', () => {
    const { map, onRejected } = pendingMap()

    expect(map.admit('pty-1', { data: 'one', creditSpans: 1 })).toBe(true)
    expect(map.admit('pty-1', { data: 'updated', creditSpans: 2 })).toBe(true)
    expect(map.delete('pty-1')).toBe(true)

    expect(map.size).toBe(0)
    expect(onRejected).not.toHaveBeenCalled()
  })

  it('rejects unique pending-ID floods after the bounded state count', () => {
    const { map, onRejected } = pendingMap()
    for (let index = 0; index < MAX_PENDING_PTY_DATA_STATES + 50; index += 1) {
      map.set(`pty-${index}`, { data: 'x', creditSpans: 1 })
    }

    expect(map.size).toBe(MAX_PENDING_PTY_DATA_STATES)
    expect(map.has('pty-0')).toBe(true)
    expect(map.has(`pty-${MAX_PENDING_PTY_DATA_STATES}`)).toBe(false)
    expect(onRejected).toHaveBeenCalledTimes(50)
  })

  it('bounds pending ID bytes, characters, and credit records independently', () => {
    const idPressure = pendingMap()
    const id = 'x'.repeat(MAX_PENDING_PTY_DATA_ID_BYTES)
    idPressure.map.set(id, { data: 'x', creditSpans: 0 })
    idPressure.map.set('extra', { data: 'x', creditSpans: 0 })
    expect(idPressure.map.size).toBe(1)
    expect(idPressure.onRejected).toHaveBeenCalledWith('extra', {
      data: 'x',
      creditSpans: 0
    })

    const charPressure = pendingMap()
    charPressure.map.set('full', {
      data: 'x'.repeat(MAX_PENDING_PTY_DATA_CHARS),
      creditSpans: 0
    })
    charPressure.map.set('extra', { data: 'x', creditSpans: 0 })
    expect(charPressure.map.size).toBe(1)
    expect(charPressure.onRejected).toHaveBeenCalledOnce()

    const creditPressure = pendingMap()
    creditPressure.map.set('full', { data: 'x', creditSpans: MAX_PENDING_PTY_DATA_CREDIT_SPANS })
    creditPressure.map.set('extra', { data: 'x', creditSpans: 1 })
    expect(creditPressure.map.size).toBe(1)
    expect(creditPressure.onRejected).toHaveBeenCalledOnce()
  })

  it('bounds accounting and warning IDs without evicting admitted live state', () => {
    const accounting = new PtyRendererDeliveryAccountingMap<number>()
    const warned = new PtyRendererDeliveryIdSet()
    for (let index = 0; index < MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES + 50; index += 1) {
      accounting.set(`pty-${index}`, index)
      warned.add(`pty-${index}`)
    }

    expect(accounting.size).toBe(MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES)
    expect(warned.size).toBe(MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES)
    expect(accounting.has('pty-0')).toBe(true)
    expect(accounting.has(`pty-${MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES}`)).toBe(false)
    expect(warned.has(`pty-${MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES}`)).toBe(false)

    const byteBounded = new PtyRendererDeliveryAccountingMap<number>()
    byteBounded.set('x'.repeat(MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_ID_BYTES), 1)
    expect(byteBounded.admit('extra', 2)).toBe(false)
    expect(byteBounded.size).toBe(1)
  })

  it('settles rejected explicit, already-settled, and fallback credit exactly once', () => {
    const explicit = vi.fn()
    const fallback = vi.fn()

    settleRejectedPtyRendererDelivery(
      7,
      [
        { chars: 2, settled: true },
        { chars: 3, credit: { charCount: 3, acknowledge: explicit } }
      ],
      fallback
    )

    expect(explicit).toHaveBeenCalledOnce()
    expect(explicit).toHaveBeenCalledWith(3)
    expect(fallback).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledWith(2)
  })
})
