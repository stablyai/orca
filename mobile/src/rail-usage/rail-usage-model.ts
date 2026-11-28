import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import {
  listProviderUsages,
  pickComposerUsageWindow,
  type AgentUsage,
  type ComposerUsageWindowChoice,
  type UsageWindowEntry
} from '../composer-usage/agent-usage-provider'

/** Every provider the host reports usage windows for, in the composer's provider order. */
export function listRailUsage(snapshot: AccountsSnapshot | null): AgentUsage[] {
  return listProviderUsages(snapshot, 'claude')
}

/** The chosen 5-hour or weekly window when the provider reports it, matching the composer meter. */
export function pickRailUsageWindow(
  windows: readonly UsageWindowEntry[],
  choice: ComposerUsageWindowChoice = 'session'
): UsageWindowEntry | null {
  return pickComposerUsageWindow(windows, choice)
}

/** The ring opens at the bottom, wide enough on the status glyph's 37pt ring for a three-digit percent. */
const RAIL_RING_GAP_DEGREES = 90
const RING_SWEEP_DEGREES = 360 - RAIL_RING_GAP_DEGREES
const RING_START_DEGREES = 180 + RAIL_RING_GAP_DEGREES / 2

/** A point `fraction` of the way clockwise along the ring's sweep, which starts at 7 o'clock. */
export function railRingPoint(
  center: number,
  radius: number,
  fraction: number
): { x: number; y: number } {
  const degrees = RING_START_DEGREES + Math.max(0, Math.min(1, fraction)) * RING_SWEEP_DEGREES
  const radians = (degrees * Math.PI) / 180
  return { x: center + radius * Math.sin(radians), y: center - radius * Math.cos(radians) }
}

/** SVG path for the sweep between two fractions. */
export function railRingArc(center: number, radius: number, from: number, to: number): string {
  if (!(to > from)) {
    return ''
  }
  const a = railRingPoint(center, radius, from)
  const b = railRingPoint(center, radius, to)
  const largeArc = (to - from) * RING_SWEEP_DEGREES > 180 ? 1 : 0
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${largeArc} 1 ${b.x} ${b.y}`
}

/** Where the rings' axis sits in the strip: on the status glyph's own, in strip points. */
export function railRingCenter(args: {
  strip: { side: 'left' | 'right'; width: number }
  windowWidth: number
  glyphMidX: number
}): number {
  const stripStart = args.strip.side === 'right' ? args.windowWidth - args.strip.width : 0
  return Math.max(0, Math.min(args.strip.width, args.glyphMidX - stripStart))
}
