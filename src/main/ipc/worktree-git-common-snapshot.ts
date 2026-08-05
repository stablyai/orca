import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Shared with the darwin primary-metadata poll so platforms cannot drift.
// `logs/HEAD` catches head moves; `config.worktree` carries the sparse flag.
export const PRIMARY_CHECKOUT_METADATA_FILES = [
  'HEAD',
  'packed-refs',
  'index',
  'config.worktree',
  'logs/HEAD'
]
const LINKED_WORKTREE_STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
export const LINKED_WORKTREE_INDEX_FILE = 'index'
export const LINKED_WORKTREE_HEAD_LOG_FILE = join('logs', 'HEAD')

function statSignature(s: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
}

export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function dirSignature(path: string): Promise<string> {
  try {
    // Why: keep `size` — on a coarse-timestamp filesystem a same-granule directory
    // allocation change would otherwise slip the readdir gate to the backstop.
    const s = await stat(path)
    return `${statSignature(s)}:${s.size}`
  } catch (error) {
    if (isMissingPathError(error)) {
      return 'missing'
    }
    throw error
  }
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? `${statSignature(s)}:${s.size}` : null
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

export type GitCommonEntrySnapshot = {
  dirSignature: string
  structuralSignatures: Map<string, string>
  indexSignature: string | null
  headLogSignature: string | null
}

export type GitCommonSnapshot = {
  worktreesDirSignature: string
  entries: Map<string, GitCommonEntrySnapshot>
  primarySignatures: Map<string, string>
  didFullScan: boolean
  /** A leaf read failed and its previous value was retained, so this scan is not authoritative. */
  degraded: boolean
}

// Why: a transient fs error (EIO/ESTALE/EMFILE/EACCES, network/SSH hiccup) must degrade to
// "nothing observable changed at this leaf" — never to a fabricated create/delete, and never to
// throwing away the whole tick's per-entry progress. The flag tells the cadence the scan is
// partial so it cannot satisfy the index backstop.
type PollDegradation = { degraded: boolean }

async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceFullScan: boolean,
  degradation: PollDegradation
): Promise<GitCommonEntrySnapshot | null> {
  // Why: HEAD, gitdir, locked, config.worktree and logs/HEAD are rewritten in place without bumping
  // the entry-dir mtime, so — like the pre-idle-gate poller — they are re-stat'd EVERY tick, never
  // gated behind the dir signature (else a raw HEAD/structural rewrite would slip to the ~30s
  // backstop). Only `index` rides the entry-dir signature (its same-dir rewrites are index-backstop-bounded).
  const structuralSignatures = new Map<string, string>()
  try {
    const [nextDirSignature, headLogSignature] = await Promise.all([
      dirSignature(entryPath),
      fileSignature(join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE)),
      Promise.all(
        LINKED_WORKTREE_STRUCTURAL_METADATA_FILES.map(async (name) => {
          const signature = await fileSignature(join(entryPath, name))
          if (signature !== null) {
            structuralSignatures.set(name, signature)
          }
        })
      )
    ])
    if (nextDirSignature === 'missing') {
      // A transient stat failure must not masquerade as a removal; the parent listing is
      // authoritative. The entry's `index` went unread either way, so this scan is not a full one —
      // otherwise a forced scan taking this path would refresh the index backstop on a partial read.
      degradation.degraded = true
      return (
        previous ?? {
          dirSignature: nextDirSignature,
          structuralSignatures,
          indexSignature: null,
          headLogSignature
        }
      )
    }
    const shouldReadIndex = forceFullScan || !previous || previous.dirSignature !== nextDirSignature
    const indexSignature = shouldReadIndex
      ? await fileSignature(join(entryPath, LINKED_WORKTREE_INDEX_FILE))
      : previous.indexSignature
    return {
      dirSignature: nextDirSignature,
      structuralSignatures,
      indexSignature,
      headLogSignature
    }
  } catch {
    degradation.degraded = true
    // No previous view to retain: omit the entry rather than half-report it. It is absent from the
    // previous snapshot too, so the diff stays silent and the next successful tick emits its create.
    return previous ?? null
  }
}

async function snapshotPrimaryCheckoutSignatures(
  commonDirPath: string,
  previous: Map<string, string> | undefined,
  degradation: PollDegradation
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>()
  await Promise.all(
    PRIMARY_CHECKOUT_METADATA_FILES.map(async (name) => {
      let signature: string | null
      try {
        signature = await fileSignature(join(commonDirPath, name))
      } catch {
        degradation.degraded = true
        signature = previous?.get(name) ?? null
      }
      if (signature !== null) {
        signatures.set(name, signature)
      }
    })
  )
  return signatures
}

export type PrimaryCheckoutMetadataSnapshot = {
  mtimes: Map<string, number>
  /** A stat failed for a non-missing reason, so this scan saw only part of the file set. */
  degraded: boolean
}

// Why: the mtime-only twin of snapshotPrimaryCheckoutSignatures, for the darwin narrow watch — the
// same files, but the linked worktrees they exclude are covered by FSEvents rather than by polling.
export async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string,
  previous?: Map<string, number>
): Promise<PrimaryCheckoutMetadataSnapshot> {
  const mtimes = new Map<string, number>()
  let degraded = false
  for (const name of PRIMARY_CHECKOUT_METADATA_FILES) {
    const filePath = join(commonDirPath, name)
    try {
      mtimes.set(filePath, (await stat(filePath)).mtimeMs)
    } catch (error) {
      if (isMissingPathError(error)) {
        continue
      }
      // Why: a transient failure (EIO/EMFILE, dead mount) must degrade to "nothing observable
      // changed here", never to a fabricated delete, and must not cost the tick the files it did
      // read. Throwing instead reset the cadence's unchanged run, pinning a flaky mount at the
      // active interval.
      degraded = true
      const previousMtime = previous?.get(filePath)
      if (previousMtime !== undefined) {
        mtimes.set(filePath, previousMtime)
      }
    }
  }
  return { mtimes, degraded }
}

export async function snapshotGitCommon(
  commonDirPath: string,
  previous?: GitCommonSnapshot,
  includePrimary = true,
  forceFullScan = false
): Promise<GitCommonSnapshot> {
  const worktreesDir = join(commonDirPath, 'worktrees')
  const degradation: PollDegradation = { degraded: false }
  const [worktreesDirSignature, primarySignatures] = await Promise.all([
    (async () => {
      try {
        return await dirSignature(worktreesDir)
      } catch (error) {
        if (!previous) {
          throw error
        }
        degradation.degraded = true
        return previous.worktreesDirSignature
      }
    })(),
    includePrimary
      ? snapshotPrimaryCheckoutSignatures(commonDirPath, previous?.primarySignatures, degradation)
      : new Map<string, string>()
  ])
  // Why: enumerate the worktrees dir EVERY tick rather than gating the readdir on its stat signature.
  // A single readdir of a small dir is negligible next to the per-entry structural stats that already
  // run each tick, and the signature gate could miss a same-granule add+remove on a coarse-mtime/FAT
  // filesystem (its size/mtime/ino/ctime all collide), leaving a linked worktree add/remove undetected
  // until the ~30s index backstop (#9882 review). The listing is the authoritative add/remove signal.
  let entryPaths: string[]
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    entryPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(worktreesDir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Dir genuinely absent (no linked worktrees, or all removed) → authoritative empty listing.
      // ENOTDIR is deliberately excluded: here it means the path exists as a FILE (a stray temp
      // file from a git operation), not that the worktrees are gone. Treating it as an empty
      // listing would diff every linked worktree as a delete.
      entryPaths = []
    } else if (previous) {
      // Why: a TRANSIENT readdir failure must neither masquerade as "every worktree removed" nor cost
      // the tick its per-entry freshness. Re-stat the known entries; a real removal surfaces on the
      // next successful listing, and an add is invisible only until then.
      degradation.degraded = true
      entryPaths = [...previous.entries.keys()]
    } else {
      throw error
    }
  }

  const entries = new Map<string, GitCommonEntrySnapshot>()
  await Promise.all(
    entryPaths.map(async (entryPath) => {
      const previousEntry = previous?.entries.get(entryPath)
      const entry = await snapshotGitCommonEntry(
        entryPath,
        previousEntry,
        forceFullScan,
        degradation
      )
      if (entry) {
        entries.set(entryPath, entry)
      }
    })
  )
  // Why: the expensive per-entry `index` read stays gated on each entry's own dir signature; onFullScan
  // now reflects an ungated index-metadata backstop fan-out (forceFullScan) — the real periodic cost —
  // rather than the always-run worktrees-dir readdir.
  return {
    worktreesDirSignature,
    entries,
    primarySignatures,
    didFullScan: forceFullScan && !degradation.degraded,
    degraded: degradation.degraded
  }
}
