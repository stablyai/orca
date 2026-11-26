// Verified private run-directory lifecycle and startup sweep for Antigravity reply-only sessions.

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import {
  isENOENT,
  isPathAbsentError
} from '../filesystem/local-file-io/filesystem-path-containment'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'

const REPLY_ONLY_PARENT_DIR = 'acp-reply-only'
const REPLY_ONLY_AGENT_DIR = 'antigravity'
const REPLY_ONLY_RUN_PREFIX = 'run-'
const REPLY_ONLY_WORK_DIR = 'work'
const OWNED_RUN_DIR_NAME = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Canonical paths of live reply-only run directories owned by this process; never swept while active. */
const activeRunDirs = new Set<string>()

function activeRunKey(canonicalPath: string): string {
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
}

function stripWindowsExtendedPrefix(pathValue: string): string {
  if (/^\\\\\?\\UNC\\/i.test(pathValue)) {
    return `\\\\${pathValue.slice('\\\\?\\UNC\\'.length)}`
  }
  if (/^\\\\\?\\[A-Za-z]:\\/.test(pathValue)) {
    return pathValue.slice('\\\\?\\'.length)
  }
  return pathValue
}

/** Verifies `canonicalChild` is a direct child named `expectedName` under `canonicalParent` (no redirects or escapes). */
export function isDirectVerifiedChild(
  canonicalParent: string,
  canonicalChild: string,
  expectedName: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathOps = platform === 'win32' ? win32 : posix
  const parent =
    platform === 'win32' ? stripWindowsExtendedPrefix(canonicalParent) : canonicalParent
  const child = platform === 'win32' ? stripWindowsExtendedPrefix(canonicalChild) : canonicalChild
  const rel = pathOps.relative(parent, child)
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.includes('/') ||
    rel.includes('\\') ||
    pathOps.isAbsolute(rel)
  ) {
    return false
  }
  return (
    rel === expectedName ||
    (platform !== 'linux' && rel.toLowerCase() === expectedName.toLowerCase())
  )
}

function isOwnedRunDirName(name: string): boolean {
  return OWNED_RUN_DIR_NAME.test(name)
}

async function verifyDirectorySegment(
  canonicalParent: string,
  segment: string,
  create: boolean
): Promise<string | null> {
  const candidate = join(canonicalParent, segment)
  let stats
  try {
    stats = await lstat(candidate)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    if (!create) {
      return null
    }
    try {
      await mkdir(candidate, { mode: 0o700 })
    } catch (mkdirError) {
      if (errnoCodeOrUnknown(mkdirError) !== 'EEXIST') {
        throw mkdirError
      }
    }
    stats = await lstat(candidate)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing symlinked or non-directory reply-only path: ${candidate}`)
  }
  const canonicalCandidate = await realpath(candidate)
  if (!isDirectVerifiedChild(canonicalParent, canonicalCandidate, segment)) {
    throw new Error(`Refusing redirected reply-only path: ${candidate}`)
  }
  return canonicalCandidate
}

async function resolveVerifiedReplyOnlyRoot(
  dataDirectory: string,
  options: { create: boolean }
): Promise<string | null> {
  let canonicalDataDir: string
  try {
    canonicalDataDir = await realpath(dataDirectory)
  } catch (error) {
    if (!isPathAbsentError(error)) {
      throw error
    }
    if (!options.create) {
      return null
    }
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    canonicalDataDir = await realpath(dataDirectory)
  }
  const dataStats = await lstat(canonicalDataDir)
  if (!dataStats.isDirectory()) {
    throw new Error(`Refusing non-directory profile root for reply-only home: ${canonicalDataDir}`)
  }
  const parentDir = await verifyDirectorySegment(
    canonicalDataDir,
    REPLY_ONLY_PARENT_DIR,
    options.create
  )
  if (!parentDir) {
    return null
  }
  return verifyDirectorySegment(parentDir, REPLY_ONLY_AGENT_DIR, options.create)
}

async function verifyOwnedRunDirectory(
  verifiedRoot: string,
  runDirName: string
): Promise<string | null> {
  if (!isOwnedRunDirName(runDirName)) {
    throw new Error(`Refusing non-owned reply-only run directory name: ${runDirName}`)
  }
  const candidate = join(verifiedRoot, runDirName)
  let stats
  try {
    stats = await lstat(candidate)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing symlinked or non-directory reply-only run directory: ${candidate}`)
  }
  const canonicalCandidate = await realpath(candidate)
  if (!isDirectVerifiedChild(verifiedRoot, canonicalCandidate, runDirName)) {
    throw new Error(`Refusing redirected reply-only run directory: ${candidate}`)
  }
  return canonicalCandidate
}

async function removeVerifiedRunDirectory(
  dataDirectory: string,
  runDirName: string,
  logger?: StructuredAgentSessionLogger
): Promise<void> {
  let verifiedRunDir: string | null
  try {
    const verifiedRoot = await resolveVerifiedReplyOnlyRoot(dataDirectory, { create: false })
    if (!verifiedRoot) {
      return
    }
    verifiedRunDir = await verifyOwnedRunDirectory(verifiedRoot, runDirName)
  } catch (error) {
    logger?.warn('Refused unsafe Antigravity reply-only home removal', {
      scope: 'antigravity-reply-only',
      dataDirectory,
      runDirName,
      error
    })
    throw error
  }
  if (!verifiedRunDir) {
    return
  }
  await rm(verifiedRunDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    (error: unknown) => {
      logger?.warn('Antigravity reply-only home folder not removed', {
        scope: 'antigravity-reply-only',
        path: verifiedRunDir,
        error
      })
    }
  )
}

/** Allocate a verified isolated run directory and empty `work/` subdirectory owned by this process. */
export async function createVerifiedAntigravityReplyOnlyRunDir(
  dataDirectory: string,
  logger?: StructuredAgentSessionLogger
): Promise<{ homeDir: string; workDir: string; release: () => Promise<void> }> {
  const verifiedRoot = await resolveVerifiedReplyOnlyRoot(dataDirectory, { create: true })
  if (!verifiedRoot) {
    throw new Error('Failed to verify Antigravity reply-only root directory')
  }
  const runDirName = `${REPLY_ONLY_RUN_PREFIX}${randomUUID()}`
  const homeDir = join(verifiedRoot, runDirName)
  const key = activeRunKey(homeDir)
  activeRunDirs.add(key)
  let created = false
  const release = async (): Promise<void> => {
    try {
      if (created) {
        await removeVerifiedRunDirectory(dataDirectory, runDirName, logger)
      }
    } finally {
      activeRunDirs.delete(key)
    }
  }
  try {
    await mkdir(homeDir, { mode: 0o700 })
    created = true
    const workDir = join(homeDir, REPLY_ONLY_WORK_DIR)
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    return { homeDir, workDir, release }
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
}

/** Sweep abandoned owned UUID `run-*` directories under the verified reply-only root without touching active runs, symlinks, or unrelated entries. */
export async function sweepAntigravityReplyOnlyHomes(
  dataDirectory: string,
  logger?: StructuredAgentSessionLogger
): Promise<number> {
  const verifiedRoot = await resolveVerifiedReplyOnlyRoot(dataDirectory, { create: false })
  if (!verifiedRoot) {
    return 0
  }
  const entries = await readdir(verifiedRoot)
  let removed = 0
  for (const entry of entries) {
    if (!isOwnedRunDirName(entry)) {
      continue
    }
    const candidate = join(verifiedRoot, entry)
    if (activeRunDirs.has(activeRunKey(candidate))) {
      continue
    }
    let verifiedRunDir: string | null
    try {
      verifiedRunDir = await verifyOwnedRunDirectory(verifiedRoot, entry)
    } catch (error) {
      logger?.warn('Skipped unsafe Antigravity reply-only run entry during sweep', {
        scope: 'antigravity-reply-only',
        path: candidate,
        error
      })
      continue
    }
    if (!verifiedRunDir || activeRunDirs.has(activeRunKey(verifiedRunDir))) {
      continue
    }
    const deleted = await rm(verifiedRunDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    }).then(
      () => true,
      (error: unknown) => {
        logger?.warn('Antigravity reply-only home folder not removed during sweep', {
          scope: 'antigravity-reply-only',
          path: verifiedRunDir,
          error
        })
        return false
      }
    )
    if (deleted) {
      removed += 1
    }
  }
  return removed
}
