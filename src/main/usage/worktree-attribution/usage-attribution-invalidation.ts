import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { UsageScanWorktreeRef } from '../provider-lifecycle/usage-provider-contract'
import { normalizeComparablePath, normalizeFsPath } from './usage-path-comparison'
import { canonicalWorktreePath } from '../../git/worktrees/catalog/worktree-path-comparison'

const worktreeRowSchema = z.object({
  repoId: z.string(),
  worktreeId: z.string(),
  path: z.string(),
  displayName: z.string()
})
const fingerprintSchema = z.array(z.string())

function parseFingerprintRows(
  fingerprint: string | null
): Map<string, UsageScanWorktreeRef> | null {
  if (fingerprint === null) {
    return null
  }
  try {
    const rows = fingerprintSchema.safeParse(JSON.parse(fingerprint))
    if (!rows.success) {
      return null
    }
    const parsed = new Map<string, UsageScanWorktreeRef>()
    for (const row of rows.data) {
      const worktree = worktreeRowSchema.safeParse(JSON.parse(row))
      if (!worktree.success) {
        return null
      }
      parsed.set(row, worktree.data)
    }
    return parsed
  } catch {
    return null
  }
}

function comparable(pathValue: string): string {
  return normalizeComparablePath(pathValue).replace(/\/+$/, '')
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

// Same equivalences as attribution (macOS /private/tmp, Windows and WSL case), without touching disk.
function spelledForms(spellings: readonly string[]): string[] {
  const forms = new Set<string>()
  for (const spelling of spellings) {
    forms.add(comparable(spelling))
    forms.add(comparable(normalizeFsPath(spelling)))
    forms.add(comparable(canonicalWorktreePath(spelling)))
  }
  return [...forms]
}

const PROBE_TIMEOUT_MS = 2_000
// All probes share this budget so a slow mount cannot hold the scan worker past its no-progress deadline.
const PROBE_BUDGET_MS = 10_000

/** Literal and resolved forms; a missing path keeps its literal forms, a path that never answers gives null. */
async function probedForms(pathValue: string, deadline: number): Promise<string[] | null> {
  const waitMs = Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())
  if (waitMs <= 0) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
  })
  const resolved = realpath(pathValue).then(
    (real) => spelledForms([pathValue, real]),
    () => spelledForms([pathValue])
  )
  try {
    return await Promise.race([resolved, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

// Own data properties only: cached records are plain JSON, never getters or inherited fields.
function fieldOf(record: unknown, field: string): unknown {
  return typeof record === 'object' && record !== null
    ? Object.getOwnPropertyDescriptor(record, field)?.value
    : undefined
}

function stringField(record: unknown, field: string): string | undefined {
  const value = fieldOf(record, field)
  return typeof value === 'string' ? value : undefined
}

function arrayField(record: unknown, field: string): readonly unknown[] {
  const value = fieldOf(record, field)
  return Array.isArray(value) ? value : []
}

// Every provider projects locations as `worktree:<id>`, `cwd:<path>` or `unscoped`.
function collectAttributionKeys(source: unknown): { keys: Set<string>; worktreeIds: Set<string> } {
  const keys = new Set<string>()
  const worktreeIds = new Set<string>()
  const add = (key: string | undefined, worktreeId: string | undefined): void => {
    if (key !== undefined) {
      keys.add(key)
    }
    if (worktreeId !== undefined) {
      worktreeIds.add(worktreeId)
    }
  }
  for (const daily of arrayField(source, 'dailyAggregates')) {
    add(stringField(daily, 'projectKey'), stringField(daily, 'worktreeId'))
  }
  for (const session of arrayField(source, 'sessions')) {
    add(undefined, stringField(session, 'primaryWorktreeId'))
    for (const location of arrayField(session, 'locationBreakdown')) {
      add(stringField(location, 'locationKey'), stringField(location, 'worktreeId'))
    }
  }
  return { keys, worktreeIds }
}

// No real stat matches this, so every scanner re-reads the source from its first byte.
const REREAD_MTIME_MS = -1

/** Keeps the record, so ownership and deleted-owner checks still see it, but forces a full re-read. */
function markForReread<T>(source: T): T {
  return typeof source === 'object' && source !== null
    ? { ...source, mtimeMs: REREAD_MTIME_MS, parseResumeState: null }
    : source
}

/**
 * A worktree add/remove/rename only moves usage located inside a changed worktree, so re-read just
 * those cached sources instead of every transcript. An unreadable cached fingerprint drops everything.
 */
export async function reattributeUsageSourcesForWorktrees<T>(
  sources: readonly T[],
  cachedFingerprint: string | null,
  currentFingerprint: string | null,
  options: { attributionResolvesCwd?: boolean } = {}
): Promise<T[]> {
  if (cachedFingerprint === currentFingerprint) {
    return [...sources]
  }
  const before = parseFingerprintRows(cachedFingerprint)
  const after = parseFingerprintRows(currentFingerprint)
  if (!before || !after) {
    return []
  }
  const changed = [
    ...[...before].filter(([row]) => !after.has(row)),
    ...[...after].filter(([row]) => !before.has(row))
  ].map(([, worktree]) => worktree)
  if (changed.length === 0) {
    return [...sources]
  }
  const deadline = Date.now() + PROBE_BUDGET_MS
  const changedIds = new Set(changed.map((worktree) => worktree.worktreeId))
  const changedForms = await Promise.all(changed.map((w) => probedForms(w.path, deadline)))
  if (changedForms.some((forms) => forms === null)) {
    // A changed worktree on an unresponsive mount: re-read everything, as a full rescan would.
    return sources.map(markForReread)
  }
  const changedPaths = changedForms.flatMap((forms) => forms ?? [])
  const rowsById = new Map<string, UsageScanWorktreeRef[]>()
  for (const worktree of [...before.values(), ...after.values()]) {
    rowsById.set(worktree.worktreeId, [...(rowsById.get(worktree.worktreeId) ?? []), worktree])
  }
  // Only worktrees a cached source names are canonicalized, so 750+ known worktrees cost nothing extra.
  const worktreeVerdicts = new Map<string, boolean>()
  const worktreeAffected = async (worktreeId: string): Promise<boolean> => {
    let verdict = worktreeVerdicts.get(worktreeId)
    if (verdict === undefined) {
      // A new worktree nested inside an unchanged one takes over that subtree's usage.
      const parents = await Promise.all(
        (rowsById.get(worktreeId) ?? []).map((w) => probedForms(w.path, deadline))
      )
      verdict =
        changedIds.has(worktreeId) ||
        parents.some(
          (forms) =>
            forms === null ||
            forms.some((parent) => changedPaths.some((child) => contains(parent, child)))
        )
      worktreeVerdicts.set(worktreeId, verdict)
    }
    return verdict
  }
  // Probe a cwd only for providers whose attribution resolves it.
  const cwdVerdicts = new Map<string, Promise<boolean>>()
  const cwdAffected = (cwd: string): Promise<boolean> => {
    let verdict = cwdVerdicts.get(cwd)
    if (verdict === undefined) {
      const inside = (forms: readonly string[]) =>
        changedPaths.some((parent) => forms.some((child) => contains(parent, child)))
      const literal = inside(spelledForms([cwd]))
      verdict =
        literal || !options.attributionResolvesCwd
          ? Promise.resolve(literal)
          : probedForms(cwd, deadline).then((forms) => forms === null || inside(forms))
      cwdVerdicts.set(cwd, verdict)
    }
    return verdict
  }
  const keyAffected = async (key: string): Promise<boolean> => {
    if (key === 'unscoped') {
      return false
    }
    if (key.startsWith('worktree:')) {
      return worktreeAffected(key.slice('worktree:'.length))
    }
    if (key.startsWith('cwd:')) {
      return cwdAffected(key.slice('cwd:'.length))
    }
    return true
  }
  const retained: T[] = []
  for (const source of sources) {
    const { keys, worktreeIds } = collectAttributionKeys(source)
    let affected = false
    for (const worktreeId of worktreeIds) {
      if (affected) {
        break
      }
      affected = await worktreeAffected(worktreeId)
    }
    for (const key of keys) {
      if (affected) {
        break
      }
      affected = await keyAffected(key)
    }
    retained.push(affected ? markForReread(source) : source)
  }
  // A re-read owner can release turns a fork deferred to it; not every scanner reclaims those itself.
  const anyMarked = retained.some((source, index) => source !== sources[index])
  return anyMarked
    ? retained.map((source) =>
        fieldOf(source, 'hasDeferredClaims') === false ? source : markForReread(source)
      )
    : retained
}
