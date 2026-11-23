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

// Same equivalences as attribution (macOS /private/tmp, Windows and WSL case), even for removed paths.
async function comparableForms(pathValue: string): Promise<string[]> {
  const spellings = [pathValue, normalizeFsPath(pathValue)]
  try {
    spellings.push(await realpath(pathValue))
  } catch {
    // Removed paths keep their literal and canonical forms.
  }
  const forms = new Set<string>()
  for (const spelling of spellings) {
    forms.add(comparable(spelling))
    forms.add(comparable(canonicalWorktreePath(spelling)))
  }
  return [...forms]
}

function fieldOf<K extends string>(record: unknown, field: K): unknown {
  return typeof record === 'object' && record !== null && field in record
    ? record[field]
    : undefined
}

function stringField<K extends string>(record: unknown, field: K): string | undefined {
  const value = fieldOf(record, field)
  return typeof value === 'string' ? value : undefined
}

function arrayField<K extends string>(record: unknown, field: K): readonly unknown[] {
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
  currentFingerprint: string | null
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
  const changedIds = new Set(changed.map((worktree) => worktree.worktreeId))
  const changedPaths = (await Promise.all(changed.map((w) => comparableForms(w.path)))).flat()
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
      const parents = (
        await Promise.all((rowsById.get(worktreeId) ?? []).map((w) => comparableForms(w.path)))
      ).flat()
      verdict =
        changedIds.has(worktreeId) ||
        parents.some((parent) => changedPaths.some((child) => contains(parent, child)))
      worktreeVerdicts.set(worktreeId, verdict)
    }
    return verdict
  }
  const cwdVerdicts = new Map<string, boolean>()
  const cwdAffected = async (cwd: string): Promise<boolean> => {
    let verdict = cwdVerdicts.get(cwd)
    if (verdict === undefined) {
      const forms = await comparableForms(cwd)
      verdict = changedPaths.some((parent) => forms.some((child) => contains(parent, child)))
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
  return retained
}
