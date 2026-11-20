import { readdir, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readHistoryBase } from './codex-rollout-history-base-header'
import { createCodexRolloutFolderStamps } from './codex-rollout-folder-stamps'
import { isNamedOn, recentDates } from './codex-rollout-recent-dates'
import {
  createNestedWslLinkProbe,
  linksIntoWsl,
  lstatUnlessAbsent,
  statUnlessAbsent
} from './codex-rollout-path-probes'
import { createCodexRolloutArchiveRelists } from './codex-rollout-archive-relists'
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
  isReferenced(rolloutId: string): Promise<boolean>
  /** Drops a deleted rollout; returns the parent it was the last fork of, if any. */
  forget(rolloutId: string): Promise<string | null>
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
  const forks = createCodexRolloutForkLinks()
  // Real sessions/archived_sessions folders read in full.
  const walkedRoots = new Set<string>()
  const stamps = createCodexRolloutFolderStamps()
  // Each re-listed folder's names when last listed.
  const listedNames = new Map<string, Set<string>>()
  // Read again on every pass; while any is left, no rollout is proven unreferenced.
  const pending = new Map<string, Pending>()
  let pendingRetriedAt = 0
  const archiveRelists = createCodexRolloutArchiveRelists(stamps, signal)
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
      return Date.now() - entry.mtimeMs >= UNFINISHED_HEADER_GRACE_MS
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
      if (known?.has(name) || (rolloutId && seen.has(rolloutId))) {
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

  /** Lists a flat folder again only when its entries changed since the last listing. */
  const relist = async (
    root: string,
    parts: readonly string[],
    visited: Set<string>,
    linked: (root: string, parts: readonly string[]) => Promise<boolean>
  ) => {
    // A dated folder, or one it sits in, linked into WSL is skipped like any link below the roots.
    if (await linked(root, parts)) {
      return true
    }
    const folder = join(root, ...parts)
    const statAt = Date.now()
    const entry = await statUnlessAbsent(folder)
    if (!entry) {
      return entry === null
    }
    if (stamps.state(folder, entry.mtimeMs) === 'current') {
      return true
    }
    if (parts.length === 0 && !archiveRelists.admit()) {
      return false
    }
    const listed = await relistNames(folder, visited)
    if (listed) {
      stamps.listed(folder, entry.mtimeMs, statAt)
    }
    return listed
  }

  const update = async (homes: readonly string[], recent: boolean): Promise<boolean> => {
    try {
      signal?.throwIfAborted()
      cache ??= await loadCodexRolloutHistoryBaseCache(cachePath)
      if (recent) {
        await archiveRelists.settle()
      }
      const visited = new Set<string>()
      const dates = recentDates()
      const linked = createNestedWslLinkProbe()
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
      let complete = true
      for (const home of homes) {
        for (const name of ['sessions', 'archived_sessions']) {
          let root: string
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
            const statAt = Date.now()
            const entry = await statUnlessAbsent(root)
            const walked = await walk(root, visited, true)
            complete &&= walked
            if (walked) {
              walkedRoots.add(root)
              // The archive is re-listed as one flat folder: this walk was its listing.
              if (entry && name !== 'sessions') {
                stamps.listed(root, entry.mtimeMs, statAt)
                archiveRelists.track(root)
              }
            }
          } else if (recent) {
            // New rollouts land in today's dated folders; archiving moves them to the flat folder.
            for (const parts of name === 'sessions' ? dates : [[]]) {
              complete = (await relist(root, parts, visited, linked)) && complete
            }
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
    isReferenced: async (rolloutId) => forks.isReferenced(rolloutId),
    forget: async (rolloutId) => {
      cache?.delete(rolloutId)
      return forks.forget(rolloutId)
    },
    save: async () => {
      archiveRelists.report()
      await cache?.save()
    }
  }
}
