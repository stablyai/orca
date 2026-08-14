/**
 * Main-side cache of the atomic `{global, byAgent}` view-attribute snapshot.
 * Fan-out is effective-diff only so a no-op inherit never clears live OSC overlays.
 */
import {
  terminalViewAttributesEqual,
  type TerminalViewAttributes
} from '../../shared/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/types'

export type TerminalViewAttributesSnapshotState = {
  global: TerminalViewAttributes
  byAgent: Partial<Record<TuiAgent, TerminalViewAttributes>>
}

export type TerminalViewAttributesApplier = (
  attributes: TerminalViewAttributes,
  scope: { launchAgent: TuiAgent | null }
) => void

let currentSnapshot: TerminalViewAttributesSnapshotState | null = null
let rendererCommittedSnapshot = false
const pushAppliers = new Set<TerminalViewAttributesApplier>()

export function registerTerminalViewAttributesApplier(
  applier: TerminalViewAttributesApplier
): void {
  pushAppliers.add(applier)
}

export function effectiveTerminalViewAttributes(
  snapshot: TerminalViewAttributesSnapshotState | null,
  launchAgent?: TuiAgent | null
): TerminalViewAttributes | null {
  if (!snapshot) {
    return null
  }
  if (launchAgent && snapshot.byAgent[launchAgent]) {
    return snapshot.byAgent[launchAgent] ?? snapshot.global
  }
  return snapshot.global
}

function collectEffectiveScopes(
  previous: TerminalViewAttributesSnapshotState | null,
  next: TerminalViewAttributesSnapshotState
): Set<TuiAgent | null> {
  const scopes = new Set<TuiAgent | null>([null])
  for (const key of Object.keys(previous?.byAgent ?? {})) {
    if (isTuiAgent(key)) {
      scopes.add(key)
    }
  }
  for (const key of Object.keys(next.byAgent)) {
    if (isTuiAgent(key)) {
      scopes.add(key)
    }
  }
  return scopes
}

export function commitTerminalViewAttributesSnapshot(snapshot: {
  global: TerminalViewAttributes
  byAgent: Partial<Record<TuiAgent, TerminalViewAttributes>>
}): void {
  const next: TerminalViewAttributesSnapshotState = {
    global: snapshot.global,
    byAgent: { ...snapshot.byAgent }
  }
  const previous = currentSnapshot
  currentSnapshot = next
  for (const scope of collectEffectiveScopes(previous, next)) {
    const oldEffective = effectiveTerminalViewAttributes(previous, scope)
    const newEffective = effectiveTerminalViewAttributes(next, scope)
    if (!newEffective) {
      continue
    }
    if (oldEffective && terminalViewAttributesEqual(oldEffective, newEffective)) {
      continue
    }
    for (const applier of pushAppliers) {
      applier(newEffective, { launchAgent: scope })
    }
  }
}

/** Compat for tests that still push a single global palette. */
export function setTerminalViewAttributes(attributes: TerminalViewAttributes): void {
  commitTerminalViewAttributesSnapshot({ global: attributes, byAgent: {} })
}

export function getTerminalViewAttributes(
  launchAgent?: TuiAgent | null
): TerminalViewAttributes | null {
  return effectiveTerminalViewAttributes(currentSnapshot, launchAgent)
}

export function hasExplicitAgentViewAttributes(agent: TuiAgent): boolean {
  return currentSnapshot?.byAgent[agent] != null
}

function rgbToCssHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function getTerminalViewColorQueryReplyColors(
  launchAgent?: TuiAgent | null
): TerminalOscColorQueryReplyColors | null {
  const attributes = getTerminalViewAttributes(launchAgent)
  if (!attributes) {
    return null
  }
  return {
    foreground: rgbToCssHex(attributes.foreground),
    background: rgbToCssHex(attributes.background)
  }
}

export function hasRendererCommittedSnapshot(): boolean {
  return rendererCommittedSnapshot
}

export function markRendererCommittedSnapshot(): void {
  rendererCommittedSnapshot = true
}

export function ptyMatchesViewAttributeScope(
  ptyLaunchAgent: TuiAgent | null | undefined,
  scopeLaunchAgent: TuiAgent | null
): boolean {
  const agent = ptyLaunchAgent ?? null
  if (agent === scopeLaunchAgent) {
    return true
  }
  return scopeLaunchAgent === null && agent !== null && !hasExplicitAgentViewAttributes(agent)
}

export function _resetTerminalViewAttributesForTest(): void {
  currentSnapshot = null
  rendererCommittedSnapshot = false
  pushAppliers.clear()
}
