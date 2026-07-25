import React from 'react'
import { Image, View, StyleSheet } from 'react-native'
import type { ImageSourcePropType } from 'react-native'

// Draws one frame of a spritesheet, scaled to fit a square box.
//
// Why an oversized Image inside a clipping View rather than a crop library: RN
// has no background-position. Scaling the WHOLE sheet and offsetting it so the
// wanted frame lands in the window is the same trick the desktop does with CSS
// background-position, needs no native module, and keeps the sheet a single
// decoded texture instead of N cropped copies.

export type SpriteFrame = { x: number; y: number; w: number; h: number }

export function MobilePetSprite({
  source,
  frame,
  sheetWidth,
  sheetHeight,
  size,
  facing
}: {
  source: ImageSourcePropType
  frame: SpriteFrame
  sheetWidth: number
  sheetHeight: number
  size: number
  /** Sprites are drawn facing right; flip horizontally to walk left. */
  facing: 'left' | 'right'
}): React.JSX.Element {
  // Fit the frame's longest side to the box so tall and wide sprites both sit
  // inside it rather than one overflowing.
  const scale = size / Math.max(frame.w, frame.h)
  return (
    <View
      style={[styles.window, { width: size, height: size }]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={source}
        // `resizeMode` is deliberately absent: the sheet is drawn at explicit
        // scaled dimensions, so any resizing mode would fight the offsets.
        style={{
          position: 'absolute',
          width: sheetWidth * scale,
          height: sheetHeight * scale,
          left: -frame.x * scale + (size - frame.w * scale) / 2,
          top: -frame.y * scale + (size - frame.h * scale) / 2,
          transform: [{ scaleX: facing === 'left' ? -1 : 1 }]
        }}
        fadeDuration={0}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  window: {
    // Clips the oversized sheet down to the single frame in view.
    overflow: 'hidden'
  }
})
