import { describe, expect, it } from 'vitest'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'

const LEAF_A = 'leaf-a'
const LEAF_B = 'leaf-b'

describe('tabRowPtyIdAfterLeafBinding', () => {
  it('fills a null row', () => {
    expect(tabRowPtyIdAfterLeafBinding({ ptyId: null }, undefined, LEAF_A, 'pty-1')).toBe('pty-1')
    expect(tabRowPtyIdAfterLeafBinding({ ptyId: null }, {}, LEAF_A, 'pty-1')).toBe('pty-1')
  })

  it('follows a respawn of the leaf the row already names', () => {
    expect(
      tabRowPtyIdAfterLeafBinding({ ptyId: 'pty-1' }, { [LEAF_A]: 'pty-1' }, LEAF_A, 'pty-1b')
    ).toBe('pty-1b')
  })

  it('leaves the row on the first pane when a sibling pane binds', () => {
    expect(
      tabRowPtyIdAfterLeafBinding(
        { ptyId: 'pty-1' },
        { [LEAF_A]: 'pty-1', [LEAF_B]: 'pty-2' },
        LEAF_B,
        'pty-2'
      )
    ).toBe('pty-1')
    // The sibling's first bind, before its leaf is in the map, must not steal the row either.
    expect(
      tabRowPtyIdAfterLeafBinding({ ptyId: 'pty-1' }, { [LEAF_A]: 'pty-1' }, LEAF_B, 'pty-2')
    ).toBe('pty-1')
  })

  it('reclaims a row that names a PTY no leaf holds', () => {
    expect(
      tabRowPtyIdAfterLeafBinding({ ptyId: 'pty-gone' }, { [LEAF_A]: 'pty-1' }, LEAF_B, 'pty-2')
    ).toBe('pty-2')
    expect(tabRowPtyIdAfterLeafBinding({ ptyId: 'pty-gone' }, undefined, LEAF_A, 'pty-1')).toBe(
      'pty-1'
    )
  })
})
