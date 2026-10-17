import { describe, expect, it, vi } from 'vitest'

// The stylesheet is the subject, so react-native is stubbed down to what it touches.
vi.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1
  }
}))

import { mobileSessionCommandInputStyles as styles } from './mobile-session-command-input-styles'

/**
 * The accessory bar is as tall as its tallest child, and the dismiss key is a child only while the
 * keyboard is up. A key taller than the accessory row made the bar about 3.7 pt taller on iOS,
 * took that from the terminal frame and cost the PTY a row whenever the keyboard opened (#23509).
 */
describe('the keyboard dismiss key', () => {
  it('takes its height from the accessory row rather than declaring one', () => {
    const key = styles.keyboardDismissKey
    expect(key).not.toHaveProperty('height')
    expect(key).not.toHaveProperty('minHeight')
    expect(key.alignSelf).toBe('stretch')
  })

  it('is inset like the accessory keys, so it is as tall as they are', () => {
    // The accessory keys sit inside the scroll row's vertical padding; the key's margins match it.
    expect(styles.keyboardDismissKey.marginVertical).toBe(styles.accessoryContent.paddingVertical)
  })
})
