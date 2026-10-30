import { z } from 'zod'

/** The iPhone Duo key rail: terminal keys the shell draws in a side inset strip for the page. */

/**
 * The grant a session page declares, optionally, when it takes key presses from the shell's rail
 * and drops its own row of those keys while the rail shows. An older page declares none, so the
 * shell never draws a rail for it.
 */
export const BRIDGE_TERMINAL_KEY_RAIL_GRANT = 'terminalKeyRail'

/**
 * Page to shell, a notify on that grant: a terminal and its key row are on screen, or no longer.
 * The shell draws the rail only while this holds, so it never sends keys into a hidden terminal.
 */
export const BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY = 'terminal-key-rail-claim'

/** Shell to page, a frame: one press of a key on the rail. */
export const BRIDGE_TERMINAL_KEY_FRAME = 'terminalKey'

/** Terminal keys the rail can send; the page applies its held modifiers, as its own key row does. */
export const BRIDGE_TERMINAL_KEY_IDS = [
  'escape',
  'tab',
  'shiftTab',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'enter',
  'ctrlC'
] as const

/** Sticky modifiers: a tap applies to the next key, a double tap keeps it on. */
export const BRIDGE_TERMINAL_MODIFIER_IDS = ['ctrl', 'alt', 'shift'] as const

export const BRIDGE_TERMINAL_TOOLBAR_KEY_IDS = [
  'toggleKeyboard',
  'toggleDisplayMode',
  'toggleInputMode',
  'moreKeys'
] as const

const StickyModifierLatchSchema = z.enum(['off', 'once', 'locked'])

export const BridgeTerminalToolbarSchema = z.object({
  canSend: z.boolean(),
  canCompose: z.boolean(),
  keyboardVisible: z.boolean(),
  liveInputEnabled: z.boolean(),
  phoneDisplayMode: z.boolean(),
  /** Agent tabs get the agent row (⇧tab, ⏎, ^C), shells the shell row, as the page's own row does. */
  runsAgent: z.boolean(),
  modifiers: z.object({
    ctrl: StickyModifierLatchSchema,
    alt: StickyModifierLatchSchema,
    shift: StickyModifierLatchSchema
  }),
  directionPadEnabled: z.boolean().optional()
})
export type BridgeTerminalToolbar = z.infer<typeof BridgeTerminalToolbarSchema>

export function sameTerminalKeyRailToolbar(
  a?: BridgeTerminalToolbar,
  b?: BridgeTerminalToolbar
): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.canSend === b.canSend &&
    a.canCompose === b.canCompose &&
    a.keyboardVisible === b.keyboardVisible &&
    a.liveInputEnabled === b.liveInputEnabled &&
    a.phoneDisplayMode === b.phoneDisplayMode &&
    a.runsAgent === b.runsAgent &&
    a.modifiers.ctrl === b.modifiers.ctrl &&
    a.modifiers.alt === b.modifiers.alt &&
    a.modifiers.shift === b.modifiers.shift &&
    a.directionPadEnabled === b.directionPadEnabled
  )
}

export const BridgeTerminalKeyIdSchema = z.union([
  z.enum(BRIDGE_TERMINAL_KEY_IDS),
  z.enum(BRIDGE_TERMINAL_MODIFIER_IDS),
  z.enum(BRIDGE_TERMINAL_TOOLBAR_KEY_IDS),
  // One printable character, typed with the held modifiers.
  z.custom<`char:${string}`>(
    (value) => typeof value === 'string' && /^char:[\x21-\x7e]$/.test(value)
  )
])
export type BridgeTerminalKeyId = z.infer<typeof BridgeTerminalKeyIdSchema>

/**
 * The keys the scrollable rail shows beside the page, in its order. Empty or absent while
 * no rail shows, including every moment the page holds no claim.
 */
export const BridgeTerminalKeyRailSchema = z.array(BridgeTerminalKeyIdSchema)

export type BridgeTerminalKeyRail = readonly BridgeTerminalKeyId[]

export function sameTerminalKeyRail(a: BridgeTerminalKeyRail, b: BridgeTerminalKeyRail): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}
