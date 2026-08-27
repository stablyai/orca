import { describe, expect, it } from 'vitest'
import { parseKeyboardLayoutSnapshot } from './macos-keyboard-layout-snapshot'

describe('parseKeyboardLayoutSnapshot', () => {
  it('accepts input-source identity and per-modifier characters', () => {
    expect(
      parseKeyboardLayoutSnapshot(
        JSON.stringify({
          inputSourceId: 'com.apple.keylayout.Latvian',
          layoutSourceId: 'com.apple.keylayout.Latvian',
          keyCharacters: {
            Digit2: {
              unmodified: '2',
              shifted: '@'
            },
            KeyE: { unmodified: 'e', shifted: null }
          }
        })
      )
    ).toEqual({
      inputSourceId: 'com.apple.keylayout.Latvian',
      layoutSourceId: 'com.apple.keylayout.Latvian',
      keyCharacters: {
        Digit2: {
          unmodified: '2',
          shifted: '@'
        },
        KeyE: {
          unmodified: 'e',
          shifted: null
        }
      }
    })
  })

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
