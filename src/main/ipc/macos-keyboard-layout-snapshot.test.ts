import { describe, expect, it } from 'vitest'
import { parseKeyboardLayoutSnapshot } from './macos-keyboard-layout-snapshot'

describe('parseKeyboardLayoutSnapshot', () => {
  it('rejects malformed snapshots and skips malformed key entries', () => {
    expect(parseKeyboardLayoutSnapshot('not json')).toBeNull()
    expect(parseKeyboardLayoutSnapshot('{}')).toBeNull()
    expect(
      parseKeyboardLayoutSnapshot(
        JSON.stringify({ inputSourceId: 42, keyCharacters: { Digit2: 42 } })
      )
    ).toEqual({ inputSourceId: null, layoutSourceId: null, keyCharacters: {} })
  })
})
