import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export type SkillBundleFileIdentity = {
  path: string
  size: number
  executable: boolean
  classification: 'text' | 'binary'
  exactSha256: string
  textNormalizedSha256: string | null
  identitySha256: string
}

type ObservedSkillFile = SkillBundleFileIdentity

export type ObservedSkillPackage = {
  files: ObservedSkillFile[]
  observedDigest: string
}

export function observedSkillPackagesMatch(
  left: ObservedSkillPackage,
  right: ObservedSkillPackage
): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every((file, index) => {
      const other = right.files[index]
      return (
        file.path === other.path &&
        file.size === other.size &&
        file.executable === other.executable &&
        file.classification === other.classification &&
        file.exactSha256 === other.exactSha256 &&
        file.identitySha256 === other.identitySha256
      )
    })
  )
}

// Ignore only plain OS metadata files, mirrored in the bundle generator, or Finder visits mark pristine copies outdated. Preserve mode-bit identity for real scripts.
const OS_METADATA_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])

export function isOsMetadataSkillEntryName(name: string): boolean {
  const folded = name.toLocaleLowerCase('en-US')
  // AppleDouble sidecars appear when the filesystem cannot store macOS metadata inline.
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
  maximumSingleFileBytes: number,
  signal?: AbortSignal
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
      if (signal?.aborted) {
        throw new Error('skill-install-cancelled')
      }
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
  const exactSha256 = sha256(bytes)
  const textNormalizedSha256 =
    normalized && (normalized.equals(bytes) ? exactSha256 : sha256(normalized))
  return {
    path,
    size: bytes.length,
    executable,
    classification: normalized ? 'text' : 'binary',
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
  limits: SkillPackageObservationLimits = SKILL_PACKAGE_OBSERVATION_LIMITS,
  executablePaths?: ReadonlySet<string>,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  inferShebangExecutables = false
): Promise<ObservedSkillPackage> {
  const files: ObservedSkillFile[] = []
  const caseFoldedPaths = new Map<string, string>()
  const normalizedExecutablePaths =
    platform === 'win32' && executablePaths
      ? new Set([...executablePaths].map((path) => path.toLocaleLowerCase('en-US')))
      : executablePaths
  let entryCount = 0
  let totalBytes = 0

  async function visit(directory: string, depth: number): Promise<void> {
    if (signal?.aborted) {
      throw new Error('skill-install-cancelled')
    }
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
    // Use code-unit ordering so runtime/build ICU differences cannot change identity.
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      if (signal?.aborted) {
        throw new Error('skill-install-cancelled')
      }
      const absolutePath = join(directory, entry.name)
      // Ignore metadata only when absent or a plain file; links/directories must still pass content guards. Filter before case-folding so sidecar spellings cannot collide.
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
        if (fileStat.nlink !== 1) {
          throw new Error('skill-package-link')
        }
        if (files.length >= limits.maximumFiles) {
          throw new Error('skill-package-file-count-limit')
        }
        const bytes = await readBoundedSkillFile(
          absolutePath,
          limits.maximumTotalBytes - totalBytes,
          limits.maximumSingleFileBytes,
          signal
        )
        totalBytes += bytes.length
        const executable = normalizedExecutablePaths
          ? normalizedExecutablePaths.has(platform === 'win32' ? folded : manifestPath)
          : platform === 'win32' && inferShebangExecutables
            ? bytes.subarray(0, 2).equals(Buffer.from('#!'))
            : (fileStat.mode & 0o111) !== 0
        files.push(describeObservedSkillFile(manifestPath, bytes, executable))
      } else {
        throw new Error('skill-package-special-file')
      }
    }
  }

  await visit(packageRoot, 0)
  return { files, observedDigest: skillPackageDigest(files) }
}

/** Require every bundled file identity; tolerate extra agent metadata such as agents/openai.yaml beside unchanged official bytes. */
export function matchesBundledSkillFiles(
  observed: ObservedSkillPackage,
  expectedFiles: readonly SkillBundleFileIdentity[]
): boolean {
  const observedByPath = new Map(observed.files.map((file) => [file.path, file]))
  return expectedFiles.every((expected) => {
    const actual = observedByPath.get(expected.path)
    return Boolean(actual && matchesFileIdentity(actual, expected))
  })
}
