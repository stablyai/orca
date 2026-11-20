import { readdir, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readHistoryBase } from './codex-rollout-history-base-header'
import { createCodexRolloutFolderStamps } from './codex-rollout-folder-stamps'
import { isNamedOn, recentDates } from './codex-rollout-recent-dates'
import { linksIntoWsl, lstatUnlessAbsent, statUnlessAbsent } from './codex-rollout-path-probes'
import {
  loadCodexRolloutHistoryBaseCache,
  type CodexRolloutHistoryBaseCache
} from './codex-rollout-history-base-cache'

// Codex creates a rollout empty and writes its header after collecting git info.
const UNFINISHED_HEADER_GRACE_MS = 10 * 60 * 1000

/**
 * Which rollouts other rollouts read their history prefix from (`session_meta.history_base`); a
 * forked chat stores only its own turns and reads the rest from its parent's file. One per sweep.
 */
export type CodexRolloutHistoryReferences = {
  /** Reads every folder of these homes not read yet. False: something couldn't be read. */
  prepare(homes: readonly string[]): Promise<boolean>
  /**
   * `prepare`, then re-lists the folders a new or newly archived rollout lands in, when they
   * changed. False when anything couldn't be read, so no rollout is proven unreferenced.
   */
  refresh(homes: readonly string[]): Promise<boolean>
  isReferenced(rolloutId: string): boolean
  /** Drops a deleted rollout; returns the parent it was the last fork of, if any. */
  forget(rolloutId: string): string | null
  save(): Promise<void>
}

/** A folder, rollout or link to read again: it couldn't be settled yet. */
type Pending = { kind: 'folder' | 'rollout' | 'link'; rolloutId: string | null; recursive: boolean }

export function createCodexRolloutHistoryReferences(
  signal?: AbortSignal
): CodexRolloutHistoryReferences {
  let cache: CodexRolloutHistoryBaseCache | undefined
  let warned = false
  let pruned = false
  // A rollout listed but gone when read was moved (archived, unarchived) or deleted meanwhile.
  let moved = false
  const seen = new Set<string>()
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()
  // Real sessions/archived_sessions folders read in full.
  const walkedRoots = new Set<string>()
  const stamps = createCodexRolloutFolderStamps()
  // Each archived_sessions folder's names when last listed.
  const listedNames = new Map<string, Set<string>>()
  // Read again on every pass; while any is left, no rollout is proven unreferenced.
  const pending = new Map<string, Pending>()
  // Recently named rollout links with no target: a target can appear without a folder changing.
  const dangling = new Map<string, string>()

  const link = (rolloutId: string, base: string | null): void => {
    seen.add(rolloutId)
    if (base === null || base === rolloutId) {
      return
    }
    baseByChild.set(rolloutId, base)
    const children = childrenByBase.get(base) ?? new Set<string>()
    children.add(rolloutId)
    childrenByBase.set(base, children)
  }

  /** False when this rollout's header can't be settled yet. */
  const visitRollout = async (path: string, rolloutId: string): Promise<boolean> => {
    if (seen.has(rolloutId)) {
      return true
    }
    const cached = cache!.get(rolloutId)
    if (cached !== undefined) {
      link(rolloutId, cached)
      return true
    }
    const header = await readHistoryBase(path)
    if (header === 'failed' || header === 'vanished') {
      moved ||= header === 'vanished'
      return header === 'vanished'
    }
    if (header === 'unreadable' || !header.settled) {
      const modified = (await statUnlessAbsent(path))?.mtimeMs ?? 0
      // A header still being written may name a base. An old one never will, and Codex's own
      // reference scan skips a rollout it can't read: it isn't cached, so a later sweep retries.
      return Date.now() - modified >= UNFINISHED_HEADER_GRACE_MS
    }
    link(rolloutId, header.base)
    await cache!.set(rolloutId, header.base)
    return true
  }

  const visitLink = async (path: string, entry: Pending, visited: Set<string>) => {
    if (await linksIntoWsl(path)) {
      return true
    }
    const target = await statUnlessAbsent(path)
    if (target === undefined) {
      return false
    }
    dangling.delete(path)
    if (target === null) {
      if (entry.rolloutId) {
        dangling.set(path, entry.rolloutId)
      }
      return true
    }
    if (target.isFile()) {
      return !entry.rolloutId || visitRollout(path, entry.rolloutId)
    }
    if (!target.isDirectory() || !entry.recursive) {
      return true
    }
    const real = await realpath(path).catch(() => null)
    if (real === null || visited.has(real)) {
      return real !== null
    }
    visited.add(real)
    return walk(path, visited, true)
  }

  const visit = async (path: string, entry: Pending, visited: Set<string>): Promise<void> => {
    const settled =
      entry.kind === 'rollout'
        ? await visitRollout(path, entry.rolloutId!)
        : entry.kind === 'folder'
          ? await walk(path, visited, entry.recursive)
          : await visitLink(path, entry, visited)
    if (settled) {
      pending.delete(path)
    } else {
      pending.set(path, entry)
    }
  }

  /** False when the folder itself couldn't be listed; entries that couldn't be read go pending. */
  const walk = async (
    folder: string,
    visited: Set<string>,
    recursive: boolean
  ): Promise<boolean> => {
    let entries: Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      return isDefinitiveAbsence(error)
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      const path = join(folder, entry.name)
      const rolloutId = codexPhysicalRolloutId(entry.name)
      if (rolloutId && seen.has(rolloutId)) {
        continue
      }
      if (entry.isFile()) {
        if (rolloutId) {
          await visit(path, { kind: 'rollout', rolloutId, recursive }, visited)
        }
      } else if (entry.isDirectory()) {
        if (recursive) {
          await visit(path, { kind: 'folder', rolloutId, recursive }, visited)
        }
      } else if (entry.isSymbolicLink()) {
        await visit(path, { kind: 'link', rolloutId, recursive }, visited)
      }
    }
    return true
  }

  /** Lists a folder again only when its entries changed since the last listing; false: failed. */
  const relist = async (folder: string, visited: Set<string>) => {
    const statAt = Date.now()
    const entry = await statUnlessAbsent(folder)
    if (entry === undefined || entry === null) {
      return entry === null && 'current'
    }
    if (stamps.isCurrent(folder, entry.mtimeMs)) {
      return 'current'
    }
    const listed = await walk(folder, visited, false)
    if (listed) {
      stamps.listed(folder, entry.mtimeMs, statAt)
    }
    return listed && 'listed'
  }

  /** Reads the names a flat folder gained since its last listing: names only, no stat per entry. */
  const relistNames = async (folder: string, visited: Set<string>): Promise<boolean> => {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch (error) {
      return isDefinitiveAbsence(error)
    }
    const known = listedNames.get(folder)
    for (const name of names) {
      const rolloutId = codexPhysicalRolloutId(name)
      if (known?.has(name) || (rolloutId && seen.has(rolloutId))) {
        continue
      }
      signal?.throwIfAborted()
      const path = join(folder, name)
      const entry = await lstatUnlessAbsent(path)
      if (entry === undefined) {
        pending.set(path, { kind: 'link', rolloutId, recursive: false })
      } else if (entry?.isFile() && rolloutId) {
        await visit(path, { kind: 'rollout', rolloutId, recursive: false }, visited)
      } else if (entry?.isSymbolicLink()) {
        await visit(path, { kind: 'link', rolloutId, recursive: false }, visited)
      }
    }
    listedNames.set(folder, new Set(names))
    return true
  }

  const update = async (homes: readonly string[], recent: boolean): Promise<boolean> => {
    try {
      signal?.throwIfAborted()
      cache ??= await loadCodexRolloutHistoryBaseCache()
      const visited = new Set<string>()
      const dates = recentDates()
      for (const [path, entry] of Array.from(pending)) {
        signal?.throwIfAborted()
        await visit(path, entry, visited)
      }
      if (recent) {
        for (const [path, rolloutId] of Array.from(dangling)) {
          if (isNamedOn(path, dates)) {
            await visit(path, { kind: 'link', rolloutId, recursive: false }, visited)
          } else {
            dangling.delete(path)
          }
        }
      }
      let complete = true
      // A rollout reaches archived_sessions only by moving out of a dated folder, which changes it.
      let datedFolderChanged = false
      for (const home of homes) {
        for (const name of ['sessions', 'archived_sessions']) {
          let root: string
          if (await linksIntoWsl(join(home, name))) {
            continue
          }
          try {
            root = await realpath(join(home, name))
          } catch (error) {
            complete &&= isDefinitiveAbsence(error)
            continue
          }
          if (visited.has(root)) {
            continue
          }
          visited.add(root)
          if (!walkedRoots.has(root)) {
            const walked = await walk(root, visited, true)
            complete &&= walked
            if (walked) {
              walkedRoots.add(root)
            }
          } else if (recent && name === 'sessions') {
            // New rollouts land in today's dated folders.
            for (const parts of dates) {
              const relisted = await relist(join(root, ...parts), visited)
              complete &&= relisted !== false
              datedFolderChanged ||= relisted === 'listed'
            }
          } else if (recent && datedFolderChanged) {
            // Orca's own deletions change archived_sessions too: those never set this off.
            complete = (await relistNames(root, visited)) && complete
          }
        }
      }
      complete &&= pending.size === 0 && !moved
      if (moved) {
        // It is somewhere this sweep may not look again: the next pass reads every folder anew.
        moved = false
        walkedRoots.clear()
      }
      // Once every folder was read in full, cached rollouts no home has any more drop out.
      if (complete && !pruned) {
        pruned = true
        cache.prune(seen)
      }
      if (!complete && !warned) {
        warned = true
        console.warn('[workspace-cleanup] Some Codex rollouts could not be read; keeping forks')
      }
      return complete
    } catch (error) {
      await cache?.save()
      throw error
    }
  }

  return {
    prepare: (homes) => update(homes, false),
    refresh: (homes) => update(homes, true),
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    forget: (rolloutId) => {
      cache?.delete(rolloutId)
      const base = baseByChild.get(rolloutId)
      if (!base) {
        return null
      }
      baseByChild.delete(rolloutId)
      const children = childrenByBase.get(base)
      children?.delete(rolloutId)
      return children?.size === 0 ? base : null
    },
    save: async () => {
      await cache?.save()
    }
  }
}
