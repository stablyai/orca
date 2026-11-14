import type { TextInputInstance } from 'react-native'

// RN 0.88 aliases TextInputInstance to an unexported class, so declaration emit cannot name refs
// typed with it in inferred hook results. An exported intersection alias keeps a nameable type.
export type MobileTextInputHandle = TextInputInstance & { readonly mobileTextInputHandle?: never }
