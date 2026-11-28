import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { KeyboardOff, X } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useKeyboardPersistingTaps } from '../../platform/keyboard/keyboard-persisting-taps'
import { feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

// The terminal key rail's sizes (terminal-dock-styles.ts); each key's Pressable is the row's full
// height, since the page ignores hitSlop.
const KEY_HEIGHT = 32
const KEY_ROW_HEIGHT = 46
const ARROW_SEGMENT_WIDTH = 28

type PageKey = { key: string; label: string }

const KEYS: readonly PageKey[] = [
  { key: 'Escape', label: 'Esc' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Shift+Tab', label: '⇧Tab' }
]
const ARROWS: readonly PageKey[] = [
  { key: 'ArrowUp', label: '↑' },
  { key: 'ArrowDown', label: '↓' },
  { key: 'ArrowLeft', label: '←' },
  { key: 'ArrowRight', label: '→' }
]

type Modifier = { name: string; label: string }

/** The host's own modifier names, so a Windows or Linux page never offers Command. */
function hostModifiers(hostPlatform: string | undefined): readonly Modifier[] {
  if (hostPlatform === 'darwin') {
    return [
      { name: 'Meta', label: '⌘' },
      { name: 'Alt', label: '⌥' },
      { name: 'Control', label: '⌃' },
      { name: 'Shift', label: '⇧' }
    ]
  }
  const pc = [
    { name: 'Control', label: 'Ctrl' },
    { name: 'Alt', label: 'Alt' },
    { name: 'Shift', label: 'Shift' }
  ]
  return hostPlatform ? pc : [{ name: 'Meta', label: 'Cmd' }, ...pc]
}

/**
 * One row of keys over the keyboard while typing on the page. Long-press a key and the row offers
 * it with each modifier instead, in place, so the keyboard stays up.
 */
export function MobileBrowserPageKeys({
  bottomInset,
  keyboardLift,
  hostPlatform,
  onKey,
  onDone
}: {
  bottomInset: number
  keyboardLift: number
  hostPlatform: string | undefined
  onKey: (key: string) => void
  onDone: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const [held, setHeld] = useState<PageKey | null>(null)
  // The finger that long-pressed is still down; its release must not press the key now under it.
  const pressedSinceHoldRef = useRef(false)
  const hold = (pageKey: PageKey) => {
    pressedSinceHoldRef.current = false
    setHeld(pageKey)
  }
  const keyButton = (pageKey: PageKey, label: string, onPress: () => void) => (
    <Pressable
      key={label}
      style={styles.target}
      onPressIn={() => {
        pressedSinceHoldRef.current = true
      }}
      onPress={() => {
        if (!held || pressedSinceHoldRef.current) {
          onPress()
        }
      }}
      onLongPress={held ? undefined : () => hold(pageKey)}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {({ pressed }) => (
        <View style={[styles.key, pressed && styles.pressed]}>
          <Text style={styles.keyText}>{label}</Text>
        </View>
      )}
    </Pressable>
  )
  return (
    // Rides the keyboard over the bar it covers, so the page's size never changes while typing.
    <View
      ref={keepsKeyboard}
      style={[styles.row, { bottom: bottomInset, transform: [{ translateY: -keyboardLift }] }]}
    >
      {held ? (
        <>
          {hostModifiers(hostPlatform)
            .filter((modifier) => !held.key.startsWith(`${modifier.name}+`))
            .map((modifier) =>
              keyButton(
                held,
                t('browser.pageKeys.modified', '{{modifier}} {{key}}', {
                  modifier: modifier.label,
                  key: held.label
                }),
                () => {
                  onKey(`${modifier.name}+${held.key}`)
                  setHeld(null)
                }
              )
            )}
          <View style={styles.spacer} />
          <GhostKey
            label={t('common.cancel', 'Cancel')}
            onPress={() => setHeld(null)}
            icon={<X size={18} color={colors.textPrimary} strokeWidth={2} />}
          />
        </>
      ) : (
        <>
          {KEYS.map((pageKey) => keyButton(pageKey, pageKey.label, () => onKey(pageKey.key)))}
          <View style={styles.arrows}>
            <View pointerEvents="none" style={styles.arrowsFill} />
            {ARROWS.map((pageKey) => (
              <Pressable
                key={pageKey.key}
                style={styles.target}
                onPress={() => onKey(pageKey.key)}
                onLongPress={() => hold(pageKey)}
                accessibilityRole="button"
                accessibilityLabel={pageKey.key}
              >
                {({ pressed }) => (
                  <View style={[styles.arrow, pressed && styles.pressed]}>
                    <Text style={styles.keyText}>{pageKey.label}</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </View>
          <View style={styles.spacer} />
          <GhostKey
            label={t('browser.pageKeys.hideKeyboard', 'Hide keyboard')}
            onPress={onDone}
            icon={<KeyboardOff size={18} color={colors.textPrimary} strokeWidth={2} />}
          />
        </>
      )}
    </View>
  )
}

function GhostKey({
  label,
  icon,
  onPress
}: {
  label: string
  icon: React.ReactNode
  onPress: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <Pressable
      style={styles.target}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {({ pressed }) => <View style={[styles.ghostKey, pressed && styles.pressed]}>{icon}</View>}
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 30,
    height: KEY_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  target: {
    height: KEY_ROW_HEIGHT,
    justifyContent: 'center'
  },
  key: {
    height: KEY_HEIGHT,
    minWidth: 34,
    paddingHorizontal: 9,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  // One key split four ways, so all four arrows fit beside Esc and Tab.
  arrows: {
    height: KEY_ROW_HEIGHT,
    flexDirection: 'row'
  },
  arrowsFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2,
    height: KEY_HEIGHT,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  arrow: {
    width: ARROW_SEGMENT_WIDTH,
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ghostKey: {
    height: KEY_HEIGHT,
    minWidth: 34,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  spacer: {
    flex: 1
  },
  keyText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: typography.monoFamily
  },
  pressed: {
    opacity: feedback.pressedOpacity
  }
}))
