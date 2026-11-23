import { readdir, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readHistoryBase } from './codex-rollout-history-base-header'
import { isNamedOn, recentDates } from './codex-rollout-recent-dates'
import {
  linksIntoWsl,
  lstatUnlessAbsent,
  pathCrossesIntoWsl,
  statUnlessAbsent
} from './codex-rollout-path-probes'
import {
  createCodexRolloutFolderRelists,
  resolveCodexRolloutRoots
} from './codex-rollout-folder-relists'
import { createCodexRolloutForkLinks } from './codex-rollout-fork-links'
import {
  loadCodexRolloutHistoryBaseCache,
  type CodexRolloutHistoryBaseCache
} from './codex-rollout-history-base-cache'

// Codex creates a rollout empty and writes its header after collecting git info.
const UNFINISHED_HEADER_GRACE_MS = 10 * 60 * 1000
const PENDING_RETRY_MS = 5000

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
  /** Whether `refresh` would be refused now, without spending anything: cheap, to ask first. */
  refreshBlocked(homes: readonly string[]): Promise<boolean>
  /** Also reads again any deleted fork of it that came back under a name it was deleted from. */
  isReferenced(rolloutId: string): Promise<boolean>
  /**
   * Drops a deleted rollout; returns the parent it was the last fork of. `paths`: every name it
   * could come back under (each home, plain or packed).
   */
  forget(rolloutId: string, paths: readonly string[]): Promise<string | null>
  save(): Promise<void>
}

/** A folder, rollout or link to read again: it couldn't be settled yet. */
type Pending = { kind: 'folder' | 'rollout' | 'link'; rolloutId: string | null; recursive: boolean }

/** The index itself; the sweep runs it in a worker (codex-rollout-history-references-client). */
export function createCodexRolloutHistoryReferences(
  cachePath: string,
  signal?: AbortSignal
): CodexRolloutHistoryReferences {
  let cache: CodexRolloutHistoryBaseCache | undefined
  let warned = false
  let pruned = false
  // A rollout listed but gone when read was moved (archived, unarchived) or deleted meanwhile.
  let moved = false
  const seen = new Set<string>()
  // Old rollouts with no header to read: re-listing a folder doesn't read them again.
  const headerless = new Set<string>()
  const forks = createCodexRolloutForkLinks()
  // Each parent's deleted forks by name: a backup can put one back anywhere, even in an old folder.
  const deletedForks = new Map<string, { rolloutId: string; path: string }[]>()
  // Real sessions/archived_sessions folders read in full.
  const walkedRoots = new Set<string>()
  // Each re-listed folder's names when last listed.
  const listedNames = new Map<string, Set<string>>()
  // Read again on every pass; while any is left, no rollout is proven unreferenced.
  const pending = new Map<string, Pending>()
  let pendingRetriedAt = 0
  const relists = createCodexRolloutFolderRelists(signal)
  // Recently named rollout links with no target: a target can appear without a folder changing.
  const dangling = new Map<string, string>()

  const link = (rolloutId: string, base: string | null): void => {
    seen.add(rolloutId)
    forks.link(rolloutId, base)
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
      const entry = await statUnlessAbsent(path)
      // Its age can't be told: read it again next pass. Gone: it moved, or Codex deleted it.
      if (!entry) {
        moved ||= entry === null
        return entry === null
      }
      // A header still being written may name a base. An old one never will, and Codex's own
      // reference scan skips a rollout it can't read: it isn't cached, so a later sweep retries.
      const old = Date.now() - entry.mtimeMs >= UNFINISHED_HEADER_GRACE_MS
      if (old) {
        headerless.add(rolloutId)
      }
      return old
    }
    link(rolloutId, header.base)
    await cache!.set(rolloutId, header.base)
    return true
  }

  const visitLink = async (path: string, entry: Pending, visited: Set<string>) => {
    // Codex's own scan never follows a link inside these folders; one into WSL can start a distro.
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

  /** Reads the names a flat folder gained since its last listing: names only, no stat per known one. */
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
      // A rollout name is skipped once read: a forgotten one restored under its name is read again.
      if (rolloutId ? seen.has(rolloutId) || headerless.has(rolloutId) : known?.has(name)) {
        continue
      }
      signal?.throwIfAborted()
      const path = join(folder, name)
      const entry = await lstatUnlessAbsent(path)
      moved ||= entry === null
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
      cache ??= await loadCodexRolloutHistoryBaseCache(cachePath)
      const visited = new Set<string>()
      const dates = recentDates()
      const resolved = await resolveCodexRolloutRoots(homes, visited)
      const { roots } = resolved
      let complete = resolved.complete
      // New rollouts land in today's dated folders; archiving moves them to the flat folder.
      const walked = roots.filter((root) => walkedRoots.has(root.path))
      const folders = recent ? await relists.settle(walked, dates) : []
      // A header still being written settles in seconds to minutes: retrying it for every candidate
      // in a burst would only repeat the same reads.
      if (Date.now() - pendingRetriedAt >= PENDING_RETRY_MS) {
        pendingRetriedAt = Date.now()
        for (const [path, entry] of Array.from(pending)) {
          signal?.throwIfAborted()
          await visit(path, entry, visited)
        }
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
      for (const root of roots.filter((entry) => !walkedRoots.has(entry.path))) {
        const stamp = await relists.beforeWalk(root, dates)
        const read = await walk(root.path, visited, true)
        complete &&= read
        if (read) {
          walkedRoots.add(root.path)
          stamp()
        }
      }
      for (const folder of folders) {
        complete = (await relists.relist(folder, (path) => relistNames(path, visited))) && complete
      }
      complete &&= !recent || (await relists.unchanged(roots, dates))
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
        console.warn('[workspace-cleanup] Some Codex rollouts could not be read yet; keeping forks')
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
    refreshBlocked: async (homes) =>
      relists.blocked((await resolveCodexRolloutRoots(homes, new Set())).roots, recentDates()),
    isReferenced: async (rolloutId) => {
      for (const fork of deletedForks.get(rolloutId) ?? []) {
        // Opening a path through a link into WSL can start a distro: a fork there keeps its parent.
        if (await pathCrossesIntoWsl(fork.path)) {
          return true
        }
        const entry = await lstatUnlessAbsent(fork.path)
        // Can't tell: it may be back.
        if (entry === undefined) {
          return true
        }
        if (entry === null) {
          continue
        }
        // Back, it needs a header read in full: unlike a scan, no age lets an unreadable one pass.
        const header = await readHistoryBase(fork.path)
        if (header === 'vanished') {
          continue
        }
        if (typeof header !== 'object' || !header.settled) {
          return true
        }
        link(fork.rolloutId, header.base)
      }
      return forks.isReferenced(rolloutId)
    },
    forget: async (rolloutId, paths) => {
      cache?.delete(rolloutId)
      seen.delete(rolloutId)
      headerless.delete(rolloutId)
      const base = forks.baseOf(rolloutId)
      if (base) {
        const deleted = deletedForks.get(base) ?? []
        deleted.push(...paths.map((path) => ({ rolloutId, path })))
        deletedForks.set(base, deleted)
      }
      return forks.forget(rolloutId)
    },
    save: async () => {
      relists.report()
      await cache?.save()
    }
  }
}
