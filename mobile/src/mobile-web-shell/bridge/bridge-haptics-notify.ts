import { z } from 'zod'

// Use notify for haptics so frequent row taps cannot fill the 64-slot request window. The envelope owns v to avoid an import cycle.

// Notify grants use capability tokens such as haptics; dotted verb names are supplied only by the native-verb table.
export const BRIDGE_HAPTICS_GRANT = 'haptics'

export const BRIDGE_HAPTICS_NOTIFY = 'native.haptics.trigger'

// Keep kinds closed and mapped to device functions; new values need compatibility negotiation because older shells reject their whole frame.
export const BRIDGE_HAPTICS_KINDS = [
  'mediumImpact',
  'selection',
  'success',
  'error',
  'edgeBump'
] as const

export type BridgeHapticsKind = (typeof BRIDGE_HAPTICS_KINDS)[number]

export const BRIDGE_HAPTICS_NOTIFY_FIELDS = {
  type: z.literal('notify'),
  name: z.literal(BRIDGE_HAPTICS_NOTIFY),
  kind: z.enum(BRIDGE_HAPTICS_KINDS)
}
