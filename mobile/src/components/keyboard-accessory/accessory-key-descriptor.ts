import type React from 'react'

export type AccessoryKeyDescriptor = {
  id: string
  // Callers supply icons with their enabled/active colors.
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
