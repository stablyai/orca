import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/**
 * The pet's speech bubble on the phone — the desktop's PetBubble, in RN.
 *
 * Positioned absolutely ABOVE the sprite and anchored to its left, mirroring
 * the desktop's `-top-2 right-full -translate-y-full`. `pointerEvents="none"`
 * throughout: the bubble is a status readout, and it must never take the tap
 * that was meant for the pet (grab/drag) or the UI behind it.
 */

/** Kept off the sprite's head rather than centred on it, so the pet stays fully
 *  visible while it talks. */
const BUBBLE_OFFSET_Y = 6

export function MobilePetBubble({
  text,
  petSize
}: {
  text: string | null
  petSize: number
}): React.JSX.Element | null {
  if (!text) {
    return null
  }
  return (
    <View
      pointerEvents="none"
      style={[styles.bubble, { bottom: petSize + BUBBLE_OFFSET_Y }]}
      accessibilityRole="text"
    >
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    left: 0,
    // Why maxWidth + numberOfLines rather than wrapping: a bubble that grows
    // tall pushes off-screen on a phone, and the text is a short status line by
    // construction (agent label + mood + optional count).
    maxWidth: 180,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  text: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  }
})
