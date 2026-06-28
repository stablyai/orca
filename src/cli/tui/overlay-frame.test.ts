import { describe, expect, it } from 'vitest'
import { overlayClick, overlayRows, type OverlayModel } from './overlay-frame'

const COLS = 60
const ROWS = 20
const confirm: OverlayModel = { kind: 'confirm', message: 'Close "shell"?' }

// The confirm box is centered; find its buttons row (last changed body line,
// just above the bottom border).
function buttonsRow(): number {
  const base = Array.from({ length: ROWS }, () => ' '.repeat(COLS))
  const out = overlayRows(base, confirm, COLS, ROWS, false)
  const changed = out.flatMap((line, i) => (line === base[i] ? [] : [i]))
  // Second-to-last changed row = the buttons line (last body row before bottom).
  const [, secondToLast] = [...changed].reverse()
  return secondToLast
}

describe('overlayClick', () => {
  it('confirms on the left half of the buttons row, cancels on the right', () => {
    const bottomBody = buttonsRow()
    expect(overlayClick(confirm, COLS, ROWS, 24, bottomBody)).toBe('confirm')
    expect(overlayClick(confirm, COLS, ROWS, 36, bottomBody)).toBe('cancel')
  })

  it('cancels a confirm when the click lands outside the box', () => {
    expect(overlayClick(confirm, COLS, ROWS, 0, 0)).toBe('cancel')
  })

  it('dismisses help on any click', () => {
    expect(overlayClick({ kind: 'help', platform: 'mac' }, COLS, ROWS, 0, 0)).toBe('dismiss')
  })

  it('returns null when no overlay is open', () => {
    expect(overlayClick({ kind: 'none' }, COLS, ROWS, 5, 5)).toBeNull()
  })
})

describe('overlayRows compositing', () => {
  it('preserves base cells to the left and right of the box', () => {
    const base = Array.from({ length: ROWS }, () => 'L'.repeat(COLS))
    const out = overlayRows(base, confirm, COLS, ROWS, false)
    const boxRow = out.find((line, i) => line !== base[i]) ?? ''
    // The row still begins and ends with the underlying chrome, not blanks.
    expect(boxRow.startsWith('L')).toBe(true)
    expect(boxRow.endsWith('L')).toBe(true)
  })
})
