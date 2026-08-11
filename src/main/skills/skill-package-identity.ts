import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SkillBundleFileIdentity, SkillKnownSnapshot } from '../../shared/skill-freshness'
import {
  gitBlobSha,
  skillPackageGitTreeSha,
  type SkillGitTreeFileEntry
} from './skill-git-tree-identity'

type ObservedSkillFile = SkillBundleFileIdentity

export type ObservedSkillPackage = {
  files: ObservedSkillFile[]
  observedDigest: string
  /**
   * Git tree sha of every observed file's raw bytes — one of the two values comparable
   * against the updater lock's `skillFolderHash` (see `officialPathsGitTreeSha`).
   */
  observedGitTreeSha: string
  /** Retained so a subset of the observed paths can be re-hashed the same way. */
  treeEntries: SkillGitTreeFileEntry[]
}

// Why: package identity compares a live user directory against a tree the generator read
// from a clean checkout, so anything the OS deposits on its own counts as drift the user
// never caused. One Finder visit writes .DS_Store, and that alone made the copy
// 'unrecognized' — reported as "may be modified", left out of the update, and unfixable by
// running it, since the updater compares its lock to the source and never reads disk.
//
// Only OS-authored names belong here. Tolerating unexpected files in general would let a
// modified skill pass: the entry is safe precisely because an official SKILL.md never
// references these, so no agent can be routed into one. Mirrored in
// config/scripts/generate-skill-bundle-manifest.mjs so neither side of the comparison can
// bake one in. Deliberately NOT extended to mode bits — that would weaken identity for
// real scripts.
const OS_METADATA_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])

export function isOsMetadataSkillEntryName(name: string): boolean {
  const folded = name.toLocaleLowerCase('en-US')
  // AppleDouble sidecars ('._SKILL.md') appear whenever a skill is copied through a
  // filesystem that cannot hold macOS metadata inline.
  return OS_METADATA_FILE_NAMES.has(folded) || folded.startsWith('._')
}

export const SKILL_PACKAGE_OBSERVATION_LIMITS = {
  maximumDepth: 16,
  maximumEntries: 2_048,
  maximumFiles: 512,
  maximumSingleFileBytes: 4 * 1024 * 1024,
  maximumTotalBytes: 32 * 1024 * 1024
} as const

type SkillPackageObservationLimits = {
  maximumDepth: number
  maximumEntries: number
  maximumFiles: number
  maximumSingleFileBytes: number
  maximumTotalBytes: number
}

async function readBoundedSkillFile(
  path: string,
  remainingTotalBytes: number,
  maximumSingleFileBytes: number
): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (before.size > maximumSingleFileBytes) {
      throw new Error('skill-package-file-size-limit')
    }
    if (before.size > remainingTotalBytes) {
      throw new Error('skill-package-total-size-limit')
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) {
        throw new Error('skill-package-changed-during-read')
      }
      offset += result.bytesRead
    }
    if ((await handle.stat()).size !== before.size) {
      throw new Error('skill-package-changed-during-read')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function normalizedText(bytes: Buffer): Buffer {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
}

export function describeObservedSkillFile(
  path: string,
  bytes: Buffer,
  executable: boolean
): ObservedSkillFile {
  let normalized: Buffer | null = null
  if (!bytes.includes(0)) {
    try {
      normalized = normalizedText(bytes)
    } catch {
      normalized = null
    }
  }
  const classification = normalized ? 'text' : 'binary'
  const exactSha256 = sha256(bytes)
  const textNormalizedSha256 = normalized ? sha256(normalized) : null
  return {
    path,
    size: bytes.length,
    executable,
    classification,
    exactSha256,
    textNormalizedSha256,
    identitySha256:
      textNormalizedSha256 !== null && !executable ? textNormalizedSha256 : exactSha256
  }
}

export function skillPackageDigest(files: readonly SkillBundleFileIdentity[]): string {
  return sha256(
    Buffer.from(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256
        }))
      )
    )
  )
}

function matchesFileIdentity(
  actual: ObservedSkillFile,
  expected: SkillBundleFileIdentity
): boolean {
  if (
    actual.path !== expected.path ||
    actual.executable !== expected.executable ||
    actual.classification !== expected.classification
  ) {
    return false
  }
  return expected.classification === 'text' && !expected.executable
    ? actual.textNormalizedSha256 === expected.textNormalizedSha256
    : actual.exactSha256 === expected.exactSha256
}

export async function observeSkillPackage(
  packageRoot: string,
  limits: SkillPackageObservationLimits = SKILL_PACKAGE_OBSERVATION_LIMITS
): Promise<ObservedSkillPackage> {
  const files: ObservedSkillFile[] = []
  const treeEntries: SkillGitTreeFileEntry[] = []
  const caseFoldedPaths = new Map<string, string>()
  let entryCount = 0
  let totalBytes = 0

  async function visit(directory: string, depth: number): Promise<void> {
    const directoryHandle = await opendir(directory)
    const entries: Dirent[] = []
    try {
      for (;;) {
        const entry = await directoryHandle.read()
        if (!entry) {
          break
        }
        entryCount += 1
        if (entryCount > limits.maximumEntries) {
          throw new Error('skill-package-entry-limit')
        }
        entries.push(entry)
      }
    } finally {
      await directoryHandle.close().catch(() => undefined)
    }
    // Why: runtime Electron and the build's Node may carry different ICU data;
    // identity order must match the generator without locale-sensitive collation.
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      // Only a plain file is OS-authored, so the type decides and not the name alone: a
      // directory or link wearing the name would otherwise hide a subtree from identity and
      // slip past the link and special-file guards below. Decided before the case-fold map
      // so two spellings of one sidecar cannot collide, and tolerant of a vanished entry so
      // an unreadable sidecar cannot fail the whole package.
      if (isOsMetadataSkillEntryName(entry.name)) {
        const sidecarStat = await lstat(absolutePath).catch(() => null)
        if (!sidecarStat || sidecarStat.isFile()) {
          continue
        }
      }
      const relativePath = relative(packageRoot, absolutePath)
      if (
        isAbsolute(relativePath) ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`)
      ) {
        throw new Error('skill-path-escape')
      }
      const manifestPath = relativePath.split(sep).join('/')
      const folded = manifestPath.toLocaleLowerCase('en-US')
      const collision = caseFoldedPaths.get(folded)
      if (collision && collision !== manifestPath) {
        throw new Error('skill-case-collision')
      }
      caseFoldedPaths.set(folded, manifestPath)
      const fileStat = await lstat(absolutePath)
      if (fileStat.isSymbolicLink()) {
        throw new Error('skill-package-link')
      }
      if (fileStat.isDirectory()) {
        if (depth >= limits.maximumDepth) {
          throw new Error('skill-package-depth-limit')
        }
        await visit(absolutePath, depth + 1)
      } else if (fileStat.isFile()) {
        if (files.length >= limits.maximumFiles) {
          throw new Error('skill-package-file-count-limit')
        }
        const bytes = await readBoundedSkillFile(
          absolutePath,
          limits.maximumTotalBytes - totalBytes,
          limits.maximumSingleFileBytes
        )
        totalBytes += bytes.length
        const executable = (fileStat.mode & 0o111) !== 0
        files.push(describeObservedSkillFile(manifestPath, bytes, executable))
        treeEntries.push({ path: manifestPath, executable, blobSha: gitBlobSha(bytes) })
      } else {
        throw new Error('skill-package-special-file')
      }
    }
  }

  await visit(packageRoot, 0)
  return {
    files,
    observedDigest: skillPackageDigest(files),
    observedGitTreeSha: skillPackageGitTreeSha(treeEntries),
    treeEntries
  }
}

/**
 * The newest revision whose every listed file is present and byte-identical.
 *
 * `officialPaths` is what the CURRENT bundle says this skill owns, and it is what
 * separates a tolerable neighbour from drift. Agent CLIs drop their own metadata
 * beside an official SKILL.md (Codex writes `agents/openai.yaml` and cannot put it
 * anywhere else), and a file no revision claims is not evidence the user edited
 * anything — so extras alone must not mark the package unrecognized.
 *
 * A file the current bundle DOES list is never an extra, even when the revision
 * being tested predates it: without that guard an older snapshot would happily match
 * a folder whose newer official file had been tampered with, laundering real drift
 * into a clean "outdated" row. Listed-file drift still fails closed either way.
 */
export function matchingKnownSnapshot(
  observed: ObservedSkillPackage,
  snapshots: readonly SkillKnownSnapshot[],
  officialPaths: ReadonlySet<string>
): SkillKnownSnapshot | null {
  const observedByPath = new Map(observed.files.map((file) => [file.path, file]))
  for (const snapshot of snapshots.toReversed()) {
    const listed = new Set(snapshot.files.map((file) => file.path))
    const launders = observed.files.some(
      (file) => !listed.has(file.path) && officialPaths.has(file.path)
    )
    if (
      !launders &&
      snapshot.files.every((expected) => {
        const actual = observedByPath.get(expected.path)
        return Boolean(actual && matchesFileIdentity(actual, expected))
      })
    ) {
      return snapshot
    }
  }
  return null
}

/**
 * The observed folder hashed as if it held only the files the current bundle owns.
 *
 * Compared against the updater lock's `skillFolderHash` ALONGSIDE the whole-folder
 * hash, never instead of it. The two cover different halves and neither subsumes the
 * other: the lock records the source tree, so a folder carrying a sidecar only ever
 * matches scoped, while an upstream revision that ADDS a file puts that file in the
 * lock's own tree and only ever matches whole. Publishing one and dropping the other
 * would trade this bug for #11220 — a clean install reading "may be modified" and its
 * update run reporting failure.
 *
 * Scoped to the CURRENT entry rather than every revision ever shipped: a leftover from
 * an older revision is exactly the stale byte the lock comparison should look past, and
 * unioning historical paths would drag it back in on the accident of its name.
 *
 * A folder holding none of them yields the whole-folder hash rather than git's empty-tree
 * sha, which is a real, matchable value: a lock that ever recorded an empty source tree
 * would otherwise vouch for every such folder.
 */
export function officialPathsGitTreeSha(
  observed: ObservedSkillPackage,
  officialPaths: ReadonlySet<string>
): string {
  const scoped = observed.treeEntries.filter((entry) => officialPaths.has(entry.path))
  return scoped.length === 0 || scoped.length === observed.treeEntries.length
    ? observed.observedGitTreeSha
    : skillPackageGitTreeSha(scoped)
}
