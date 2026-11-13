import { describe, expect, it } from 'vitest'
import { isComputerTreeElementDisabled } from './computer-tree-query'

describe('isComputerTreeElementDisabled', () => {
  it.each([
    ['12 (disabled) File', true],
    ['\t3 push button (selected, disabled, settable) Save', true],
    ['4 action (primary) (disabled) Continue', true],
    ['5 push button (selected) Save (beta)', false],
    ['6 push button Continue, Description: Next step', false]
  ])('reads %s as disabled=%s', (line, disabled) => {
    expect(isComputerTreeElementDisabled({ index: 0, depth: 0, lines: [line] })).toBe(disabled)
  })
})
