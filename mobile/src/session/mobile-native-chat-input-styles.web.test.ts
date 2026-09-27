import { describe, expect, it, vi } from 'vitest'

// StyleSheet.create is identity in React Native and on RN Web alike, and every other export of the
// module reaches the native runtime this test does not have.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles }
}))

// The seam as the page bundle resolves it. Without this the `.web.ts` styles below would read the
// native seam and the test would pass on a size that no browser ever renders.
vi.mock(
  '../platform/text-input-font-size',
  async () => await import('../platform/text-input-font-size.web')
)

import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { TEXT_INPUT_FONT_SIZE_FLOOR } from '../platform/text-input-font-size.web'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { mobileNativeChatInputBase } from './mobile-native-chat-input-base-styles'
import { mobileNativeChatInputStyles } from './mobile-native-chat-input-styles'
import { mobileNativeChatInputStyles as onWeb } from './mobile-native-chat-input-styles.web'

/** Every property the two fields carried before the split, read off the commit that split them. */
const BEFORE_THE_SPLIT = {
  input: {
    width: '100%',
    maxHeight: 140,
    minHeight: 40,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  freeInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  }
} as const

const KEYS = ['input', 'freeInput'] as const

describe('the chat composer and question fields natively', () => {
  it.each(KEYS)('renders exactly what it rendered before the split: %s', (key) => {
    expect(mobileNativeChatInputStyles[key]).toEqual(BEFORE_THE_SPLIT[key])
    // Key for key as well as value for value: `toEqual` would pass over an extra undefined.
    expect(Object.keys(mobileNativeChatInputStyles[key]).sort()).toEqual(
      Object.keys(BEFORE_THE_SPLIT[key]).sort()
    )
  })

  it('sits one point under the floor, which is why the split exists', () => {
    // The premise, not a restatement: if the body size ever rose to 15 this whole pair collapses
    // into an in-place move and someone should be told rather than left maintaining three files.
    expect(BEFORE_THE_SPLIT.input.fontSize).toBeLessThan(TEXT_INPUT_FONT_SIZE_FLOOR)
  })
})

describe('the chat composer and question fields on the web', () => {
  it.each(KEYS)('takes its size from the seam, clear of the focus-zoom floor: %s', (key) => {
    expect(onWeb[key].fontSize).toBe(TEXT_INPUT_FONT_SIZE)
    expect(onWeb[key].fontSize).toBeGreaterThanOrEqual(TEXT_INPUT_FONT_SIZE_FLOOR)
    expect(onWeb[key].fontSize).toBeGreaterThan(BEFORE_THE_SPLIT[key].fontSize)
  })

  // The split is one value, not a second style: everything the siblings do not differ on comes from
  // the same object, so a padding or a colour cannot drift between the platforms.
  it.each(KEYS)('differs from the native style in nothing but the size: %s', (key) => {
    expect(mobileNativeChatInputBase[key]).not.toHaveProperty('fontSize')
    expect(mobileNativeChatInputStyles[key]).toMatchObject(mobileNativeChatInputBase[key])
    expect(onWeb[key]).toMatchObject(mobileNativeChatInputBase[key])
    expect(Object.keys(onWeb[key]).sort()).toEqual(
      Object.keys(mobileNativeChatInputStyles[key]).sort()
    )
  })

  it('keeps the two fields apart where they were always apart', () => {
    // A shared base is how two styles drift into one. The composer spans its row; the question's
    // field shares the row with a send button, and neither shape is the other's.
    expect(onWeb.input).toMatchObject({ width: '100%', maxHeight: 140 })
    expect(onWeb.freeInput).toMatchObject({ flex: 1, maxHeight: 120 })
  })
})
