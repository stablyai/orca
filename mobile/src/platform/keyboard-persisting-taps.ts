export type KeyboardPersistingTaps = 'always' | 'handled'

/** Natively a Pressable never takes focus; the ScrollView's `keyboardShouldPersistTaps` is the rule. */
export function useKeyboardPersistingTaps(_mode: KeyboardPersistingTaps): undefined {
  return undefined
}
