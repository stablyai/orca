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
  /** Git tree sha of the raw bytes — comparable against the updater lock's skillFolderHash. */
  observedGitTreeSha: string
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
    observedGitTreeSha: skillPackageGitTreeSha(treeEntries)
  }
}

export function matchingKnownSnapshot(
  observed: ObservedSkillPackage,
  snapshots: readonly SkillKnownSnapshot[]
): SkillKnownSnapshot | null {
  for (const snapshot of snapshots.toReversed()) {
    if (snapshot.files.length !== observed.files.length) {
      continue
    }
    if (
      snapshot.files.every((expected, index) => {
        const actual = observed.files[index]
        return Boolean(actual && matchesFileIdentity(actual, expected))
      })
    ) {
      return snapshot
    }
  }
  return null
}
