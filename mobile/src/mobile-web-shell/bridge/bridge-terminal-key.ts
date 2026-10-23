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

/** The rail's keys, in the order it lists them; ids of the page's terminal accessory keys and paste. */
export const BRIDGE_TERMINAL_KEY_IDS = [
  'escape',
  'tab',
  'shiftTab',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'enter',
  'ctrlC',
  'paste'
] as const

export type BridgeTerminalKeyId = (typeof BRIDGE_TERMINAL_KEY_IDS)[number]

/**
 * The keys the rail shows beside the page, in its order; a short strip holds the first few, and the
 * page keeps the rest in its own row. Empty, or absent on the wire, while no rail shows, which
 * includes every moment the page holds no claim.
 */
export const BridgeTerminalKeyRailSchema = z
  .array(z.enum(BRIDGE_TERMINAL_KEY_IDS))
  .max(BRIDGE_TERMINAL_KEY_IDS.length)

export type BridgeTerminalKeyRail = readonly BridgeTerminalKeyId[]

export function sameTerminalKeyRail(a: BridgeTerminalKeyRail, b: BridgeTerminalKeyRail): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}
