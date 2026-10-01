/** A held Pressable's ref; natively there is nothing to attach, so it is always absent. */
export type HoldPressTouchRef = undefined | ((node: unknown) => void)

/** Natively the OS long-press never interrupts a held Pressable; nothing to attach. */
export function useHoldPressTouchRef(_active: boolean): HoldPressTouchRef {
  return undefined
}
