import { describe, expect, it } from 'vitest'
import { MAX_TERMINAL_COLS } from '../../shared/terminal-size-limits'
import { HeadlessEmulator } from './headless-emulator'

describe('HeadlessEmulator terminal size limits', () => {
  it('uses safe defaults for oversized persisted construction and resize dimensions', () => {
    const emulator = new HeadlessEmulator({ cols: MAX_TERMINAL_COLS + 1, rows: 24 })
    expect(emulator.getAppliedSize()).toEqual({ cols: 80, rows: 24 })

    emulator.resize(80, Number.MAX_SAFE_INTEGER)
    expect(emulator.getAppliedSize()).toEqual({ cols: 80, rows: 24 })
    emulator.dispose()
  })
})
