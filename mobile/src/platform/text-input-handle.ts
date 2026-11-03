import type { TextInputInstance } from 'react-native'

// RN 0.88 aliases TextInputInstance to an unexported class, so declaration emit cannot name refs
// typed with it in inferred hook results. This exported interface gives them a nameable type.
// oxlint-disable-next-line typescript/consistent-type-definitions -- A type alias would collapse back to RN's unexported class.
export interface MobileTextInputHandle extends TextInputInstance {}
