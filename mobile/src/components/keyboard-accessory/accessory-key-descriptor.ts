import type React from 'react'

// Why: one descriptor shape drives every accessory key on both the terminal and
// browser bars, so a new button is a new list entry rather than a component change.
export type AccessoryKeyDescriptor = {
  id: string
  // A text key sets `label`; an icon key sets `icon`. The caller colors icons
  // (the bar cannot recolor a prebuilt node), matching per-tab enabled/active state.
  label?: string
  icon?: React.ReactNode
  // Sticky/toggle keys (terminal live-input, browser pointer modifiers) set `active`.
  active?: boolean
  // Defaults to the bar-level `disabled`; an always-enabled key (terminal `+`) sets `false`.
  disabled?: boolean
  // Custom terminal keys carry a border (the old `customAccessoryKey` style).
  bordered?: boolean
  onPress?: () => void
  onPressIn?: () => void
  onPressOut?: () => void
  onLongPress?: () => void
  delayLongPress?: number
  accessibilityLabel?: string
}
