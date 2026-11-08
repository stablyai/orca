// Runtime control of the relay edge on the director: director/edge.json in the relay-control
// bucket, read by the shared flag channel (cell/control-flags/relay-control-flag-channel.ts), so a
// rollout step or a rollback needs no director deploy. Boot uses the defaults (mode on, the env
// rollout percent); a failed read keeps the last applied flags.
import { z } from 'zod'
import {
  startControlFlagChannel,
  type ControlFlagParse
} from './cell/control-flags/relay-control-flag-channel.js'

// `off`: no host is in the cohort; hosts on the edge leave normally (export, place, fence) and the
// evacuation sweep drains them. `down`: as off, and the edge is known dead, so a leaving host's
// export is skipped at once (EdgeAssignments.leaveEdge).
export type EdgeControlMode = 'on' | 'off' | 'down'

export type EdgeControlFlags = {
  mode: EdgeControlMode
  // Replaces the env rollout percent when present (1‰ steps).
  rolloutPermille?: number
}

export const EDGE_CONTROL_DEFAULTS: EdgeControlFlags = { mode: 'on' }
export const EDGE_CONTROL_OBJECT_NAME = 'director/edge.json'
export const EDGE_CONTROL_APPLIED_EVENT = 'orca_relay_edge_control_applied'

const EdgeControlFlagsSchema = z.object({
  mode: z.enum(['on', 'off', 'down']).default(EDGE_CONTROL_DEFAULTS.mode),
  rolloutPermille: z.number().int().min(0).max(1_000).optional()
})
const KNOWN_FLAG_KEYS = new Set(Object.keys(EdgeControlFlagsSchema.shape))
const EdgeControlObjectSchema = z.object({ v: z.literal(1), flags: EdgeControlFlagsSchema })

// Unknown keys (a newer writer's, or a typo) are dropped and reported; a known key with a bad value
// voids the whole object, so the last applied flags stay.
export const parseEdgeControl: ControlFlagParse<EdgeControlFlags> = (body) => {
  const parsed = EdgeControlObjectSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const named = body !== null && typeof body === 'object' && 'flags' in body ? body.flags : {}
  const ignoredKeys =
    named !== null && typeof named === 'object'
      ? Object.keys(named).filter((key) => !KNOWN_FLAG_KEYS.has(key)).sort()
      : []
  const { mode, rolloutPermille } = parsed.data.flags
  return { flags: rolloutPermille === undefined ? { mode } : { mode, rolloutPermille }, ignoredKeys }
}

export type EdgeControl = {
  // The flags applied now; callers read this on every decision, never caching it.
  flags: () => EdgeControlFlags
  // Called after each newly applied generation.
  onChange: (listener: () => void) => void
  stop: () => void
}

export function startEdgeControl(
  input: { fetch?: typeof fetch; random?: () => number; pollMs?: number; autoStart?: boolean } = {}
): EdgeControl & { poll: () => Promise<void> } {
  const listeners: (() => void)[] = []
  const channel = startControlFlagChannel({
    objectName: EDGE_CONTROL_OBJECT_NAME,
    defaults: EDGE_CONTROL_DEFAULTS,
    parse: parseEdgeControl,
    appliedEvent: EDGE_CONTROL_APPLIED_EVENT,
    onApplied: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    ...input
  })
  return {
    flags: () => channel.applied().flags,
    onChange: (listener) => {
      listeners.push(listener)
    },
    poll: channel.poll,
    stop: channel.stop
  }
}

// Effective share of hosts on the edge in permille: the applied flag, else the env percent.
export function edgeRolloutPermille(rolloutPercent: number, flags: EdgeControlFlags): number {
  return flags.rolloutPermille ?? rolloutPercent * 10
}
