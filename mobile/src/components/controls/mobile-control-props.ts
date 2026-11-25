export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

export type MobileSliderProps = {
  value: number
  min: number
  max: number
  step?: number
  /** Each step the thumb crosses, so a preview can follow the drag. */
  onValueChange: (value: number) => void
  /** Once per drag, tap or accessibility step, for work that should not run every step. */
  onSlidingComplete?: (value: number) => void
  accessibilityLabel: string
  /** Spoken in place of the bare number, e.g. "13 points". */
  accessibilityValueText?: string
  disabled?: boolean
  testID?: string
}
