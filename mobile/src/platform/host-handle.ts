import type { HostInstance } from 'react-native'

// RN 0.88 aliases HostInstance to an unexported class, so declaration emit cannot name refs
// typed with it in inferred hook results. An exported intersection alias keeps a nameable type.
export type MobileHostHandle = HostInstance & { readonly mobileHostHandle?: never }
