import { describe, expect, it } from 'vitest'
import {
  readTerminalViewportDims,
  resolveTerminalViewportResubscribe,
  shouldResubscribeAfterViewportMeasure
} from './mobile-terminal-viewport-resubscribe'

const PHONE = { cols: 40, rows: 50 }

describe('readTerminalViewportDims', () => {
  it('accepts only usable numeric host dimensions', () => {
    expect(readTerminalViewportDims({ cols: 40, rows: 50 })).toEqual({
      hostCols: 40,
      hostRows: 50
    })
    expect(readTerminalViewportDims({ cols: Number.NaN, rows: 0 })).toEqual({
      hostCols: null,
      hostRows: null
    })
  })
})

describe('resolveTerminalViewportResubscribe', () => {
  it('holds on absent host dims instead of resubscribing (STA-3337 regression)', () => {
    for (const [hostCols, hostRows] of [
      [null, null],
      [80, null],
      [null, 24]
    ] as const) {
      expect(
        resolveTerminalViewportResubscribe({
          hostCols,
          hostRows,
          viewportMeasured: true,
          viewport: PHONE,
          attempts: 0
        })
      ).toEqual({ kind: 'hold' })
    }
  })

  it('converges when host dims match the measured viewport', () => {
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        viewportMeasured: true,
        viewport: PHONE,
        attempts: 2
      })
    ).toEqual({ kind: 'converged' })
  })

  it('accepts desktop dims in desktop mode instead of treating them as a failed fit (#28487)', () => {
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: 150,
        hostRows: 40,
        viewportMeasured: true,
        viewport: PHONE,
        attempts: 0,
        displayMode: 'desktop'
      })
    ).toEqual({ kind: 'converged' })
  })
})

describe('shouldResubscribeAfterViewportMeasure', () => {
  it('always resubscribes when the viewport was never measured (server must learn it)', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        measured: PHONE,
        viewportWasMeasured: false
      })
    ).toBe(true)
  })

  it('skips the resubscribe when the fresh measure already matches the host', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        measured: PHONE,
        viewportWasMeasured: true
      })
    ).toBe(false)
  })

  it('resubscribes when the host still disagrees with the fresh measure', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: 80,
        hostRows: 24,
        measured: PHONE,
        viewportWasMeasured: true
      })
    ).toBe(true)
  })
})
