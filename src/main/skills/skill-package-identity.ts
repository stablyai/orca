import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SkillBundleFileIdentity, SkillKnownSnapshot } from '../../shared/skill-freshness'

type ObservedSkillFile = SkillBundleFileIdentity

export type ObservedSkillPackage = {
  files: ObservedSkillFile[]
  observedDigest: string
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
        files.push(describeObservedSkillFile(manifestPath, bytes, (fileStat.mode & 0o111) !== 0))
      } else {
        throw new Error('skill-package-special-file')
      }
    }
  }

  await visit(packageRoot, 0)
  return { files, observedDigest: skillPackageDigest(files) }
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
