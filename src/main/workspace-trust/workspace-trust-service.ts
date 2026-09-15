import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveWorkspaceTrustMatch } from '../../shared/workspace-trust-resolution'
import type { WorkspaceTrustChange, WorkspaceTrustEntry } from '../../shared/workspace-trust-types'
import { resolveWorkspaceTrustForPath } from './workspace-trust-path-canonicalization'

export type WorkspaceTrustStore = {
  getSettings(): Pick<GlobalSettings, 'workspaceTrustEntries'>
  updateSettings(
    updates: Pick<GlobalSettings, 'workspaceTrustEntries'>,
    options?: { notifyListeners?: boolean }
  ): unknown
}

export type WorkspaceTrustDecisionArgs = {
  path: string
  scope: 'workspace' | 'parent'
  decision: 'trust' | 'decline'
  origin: WorkspaceTrustEntry['origin']
}

let revision = 0
const listeners = new Set<(change: WorkspaceTrustChange) => void>()

function emitChange(changedRoots: string[], reason: WorkspaceTrustChange['reason']): void {
  revision += 1
  const change: WorkspaceTrustChange = { changedRoots, revision, reason }
  for (const listener of listeners) {
    listener(change)
  }
}

/** Ships with zero consumers deliberately (design decision 5/7) — unretrofittable once a long-lived process runs under trust. */
export function onWorkspaceTrustChanged(
  listener: (change: WorkspaceTrustChange) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getEntries(store: WorkspaceTrustStore): WorkspaceTrustEntry[] {
  return store.getSettings().workspaceTrustEntries ?? []
}

/** Two-phase gate: never a UI-only signal. This is the only function capability code should call. */
export async function isWorkspaceTrusted(
  path: string,
  store: WorkspaceTrustStore
): Promise<boolean> {
  return resolveWorkspaceTrustForPath(path, getEntries(store))
}

/** UI/prompt display only — textual match, never consulted by a gate (undecided must never leak into capability logic). */
export async function getWorkspaceTrustDecision(
  path: string,
  store: WorkspaceTrustStore
): Promise<'trusted' | 'declined' | 'undecided'> {
  const match = resolveWorkspaceTrustMatch(path, getEntries(store))
  if (!match) {
    return 'undecided'
  }
  return match.entry.trusted ? 'trusted' : 'declined'
}

export async function recordWorkspaceTrustDecision(
  store: WorkspaceTrustStore,
  args: WorkspaceTrustDecisionArgs
): Promise<WorkspaceTrustEntry> {
  const targetPath = args.scope === 'parent' ? dirname(args.path) : args.path
  const normalizedTarget = normalizeRuntimePathForComparison(targetPath)
  const entry: WorkspaceTrustEntry = {
    id: randomUUID(),
    path: targetPath,
    trusted: args.decision === 'trust',
    decidedAt: Date.now(),
    origin: args.origin
  }
  const remaining = getEntries(store).filter(
    (existing) => normalizeRuntimePathForComparison(existing.path) !== normalizedTarget
  )
  // Why: persistence notifies only on opt-in, and that broadcast is how a decision reaches
  // open windows. No `originWebContentsId` — unlike plugin enablement nothing repaints
  // optimistically here, so the deciding window needs the event as much as any other.
  store.updateSettings({ workspaceTrustEntries: [...remaining, entry] }, { notifyListeners: true })
  emitChange([targetPath], args.decision === 'trust' ? 'granted' : 'declined')
  return entry
}

export async function revokeWorkspaceTrustEntry(
  store: WorkspaceTrustStore,
  entryId: string
): Promise<boolean> {
  const entries = getEntries(store)
  const target = entries.find((entry) => entry.id === entryId)
  if (!target) {
    return false
  }
  store.updateSettings(
    { workspaceTrustEntries: entries.filter((entry) => entry.id !== entryId) },
    { notifyListeners: true }
  )
  emitChange([target.path], 'revoked')
  return true
}
