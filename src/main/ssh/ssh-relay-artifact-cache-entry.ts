import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  createSshRelayArtifactCacheEntryProof,
  sshRelayArtifactCacheEntryProofBytes,
  SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME
} from './ssh-relay-artifact-cache-entry-proof'
import {
  copyVerifiedSshRelayArtifactCacheArchive,
  verifySshRelayArtifactCacheEntry,
  type SshRelayArtifactCacheEntry
} from './ssh-relay-artifact-cache-entry-verification'
import { acquireSshRelayArtifactCacheLock } from './ssh-relay-artifact-cache-lock'
import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import { extractSshRelayArtifact } from './ssh-relay-artifact-extraction'
import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const TRANSACTION_TIMEOUT_MS = 5 * 60_000
const MAXIMUM_INCREMENTAL_MEMORY_BYTES = 80 * 1024 * 1024
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/

type CacheDirectories = {
  root: string
  entries: string
  quarantine: string
}

function exactContentHex(contentId: SshRelayDigest): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache content ID must be an exact lowercase SHA-256 digest')
  }
  return match[1]
}

export function sshRelayArtifactCacheEntryPath(
  cacheRoot: string,
  contentId: SshRelayDigest
): string {
  return resolve(cacheRoot, 'entries', exactContentHex(contentId))
}

async function ensureOwnedDirectory(parent: string, name: string): Promise<string> {
  const logical = join(parent, name)
  await mkdir(logical, { recursive: true, mode: 0o700 })
  const metadata = await lstat(logical)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`SSH relay artifact cache ${name} path must be an owned directory`)
  }
  const physical = await realpath(logical)
  if (dirname(physical) !== parent || basename(physical) !== name) {
    throw new Error(`SSH relay artifact cache ${name} path must not traverse a link`)
  }
  return physical
}

async function prepareCacheDirectories(cacheRoot: string): Promise<CacheDirectories> {
  const logicalRoot = resolve(cacheRoot)
  await mkdir(logicalRoot, { recursive: true, mode: 0o700 })
  const rootMetadata = await lstat(logicalRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('SSH relay artifact cache root must be an owned directory')
  }
  const root = await realpath(logicalRoot)
  const entries = await ensureOwnedDirectory(root, 'entries')
  const quarantine = await ensureOwnedDirectory(root, 'quarantine')
  return { root, entries, quarantine }
}

function effectiveSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TRANSACTION_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function cleanStaleStaging(
  entries: string,
  contentHex: string,
  signal: AbortSignal
): Promise<void> {
  const pattern = new RegExp(`^${contentHex}\\.pending-[0-9a-f]{32}$`)
  for (const name of await readdir(entries)) {
    signal.throwIfAborted()
    if (pattern.test(name)) {
      // Why: the same-content lock proves these token-shaped remnants have no active publisher.
      await rm(join(entries, name), { recursive: true, force: true })
    }
  }
}

export class SshRelayArtifactCacheIntegrityError extends Error {
  readonly quarantinePath: string | null

  constructor(message: string, quarantinePath: string | null, cause: unknown) {
    super(message, { cause })
    this.name = 'SshRelayArtifactCacheIntegrityError'
    this.quarantinePath = quarantinePath
  }
}

async function quarantineCorruptEntry({
  entryPath,
  quarantineDirectory,
  contentHex,
  cause
}: {
  entryPath: string
  quarantineDirectory: string
  contentHex: string
  cause: unknown
}): Promise<never> {
  const quarantinePath = join(
    quarantineDirectory,
    `${contentHex}.corrupt-${randomBytes(16).toString('hex')}`
  )
  try {
    // Why: detected corruption becomes unselectable before diagnostics or later recovery can proceed.
    await rename(entryPath, quarantinePath)
  } catch (quarantineError) {
    throw new SshRelayArtifactCacheIntegrityError(
      'SSH relay artifact cache entry is corrupt and could not be quarantined',
      null,
      new AggregateError([cause, quarantineError], 'Cache verification and quarantine both failed')
    )
  }
  throw new SshRelayArtifactCacheIntegrityError(
    'SSH relay artifact cache entry failed integrity verification and was quarantined',
    quarantinePath,
    cause
  )
}

async function verifyExistingOrQuarantine({
  entryPath,
  artifact,
  signal,
  directories
}: {
  entryPath: string
  artifact: SshRelaySelectedArtifact
  signal: AbortSignal
  directories: CacheDirectories
}): Promise<SshRelayArtifactCacheEntry> {
  try {
    return await verifySshRelayArtifactCacheEntry({ entryPath, artifact, signal })
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted()
    }
    return quarantineCorruptEntry({
      entryPath,
      quarantineDirectory: directories.quarantine,
      contentHex: exactContentHex(artifact.contentId),
      cause: error
    })
  }
}

async function writeProof(
  path: string,
  artifact: SshRelaySelectedArtifact,
  runtime: { files: number; expandedBytes: number }
): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(
      sshRelayArtifactCacheEntryProofBytes(createSshRelayArtifactCacheEntryProof(artifact, runtime))
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export type SshRelayArtifactCacheLookup =
  | { kind: 'miss' }
  | { kind: 'hit'; entry: SshRelayArtifactCacheEntry }

export async function lookupSshRelayArtifactCacheEntry({
  cacheRoot,
  artifact,
  signal
}: {
  cacheRoot: string
  artifact: SshRelaySelectedArtifact
  signal?: AbortSignal
}): Promise<SshRelayArtifactCacheLookup> {
  const activeSignal = effectiveSignal(signal)
  activeSignal.throwIfAborted()
  const directories = await prepareCacheDirectories(cacheRoot)
  const contentHex = exactContentHex(artifact.contentId)
  const entryPath = join(directories.entries, contentHex)
  const lock = await acquireSshRelayArtifactCacheLock({
    cacheRoot: directories.root,
    contentId: artifact.contentId,
    signal: activeSignal
  })
  try {
    await cleanStaleStaging(directories.entries, contentHex, activeSignal)
    if (!(await pathExists(entryPath))) {
      return { kind: 'miss' }
    }
    return {
      kind: 'hit',
      entry: await verifyExistingOrQuarantine({
        entryPath,
        artifact,
        signal: activeSignal,
        directories
      })
    }
  } finally {
    await lock.release()
  }
}

export async function publishSshRelayArtifactCacheEntry({
  cacheRoot,
  artifact,
  archivePath,
  signal
}: {
  cacheRoot: string
  artifact: SshRelaySelectedArtifact
  archivePath: string
  signal?: AbortSignal
}): Promise<SshRelayArtifactCacheEntry> {
  const activeSignal = effectiveSignal(signal)
  activeSignal.throwIfAborted()
  const directories = await prepareCacheDirectories(cacheRoot)
  const contentHex = exactContentHex(artifact.contentId)
  const entryPath = join(directories.entries, contentHex)
  const lock = await acquireSshRelayArtifactCacheLock({
    cacheRoot: directories.root,
    contentId: artifact.contentId,
    signal: activeSignal
  })
  let stagingPath: string | null = null
  try {
    await cleanStaleStaging(directories.entries, contentHex, activeSignal)
    if (await pathExists(entryPath)) {
      try {
        return await verifyExistingOrQuarantine({
          entryPath,
          artifact,
          signal: activeSignal,
          directories
        })
      } catch (error) {
        if (!(error instanceof SshRelayArtifactCacheIntegrityError) || !error.quarantinePath) {
          throw error
        }
        // A quarantined entry may be replaced only by the fresh verified source below.
      }
    }

    stagingPath = `${entryPath}.pending-${lock.token}`
    await mkdir(stagingPath, { mode: 0o700 })
    const stagedArchive = join(stagingPath, artifact.archive.name)
    await copyVerifiedSshRelayArtifactCacheArchive({
      sourcePath: resolve(archivePath),
      destinationPath: stagedArchive,
      artifact,
      signal: activeSignal
    })
    const extraction = await extractSshRelayArtifact({
      artifact,
      archivePath: stagedArchive,
      outputDirectory: join(stagingPath, 'runtime'),
      signal: activeSignal
    })
    await writeProof(
      join(stagingPath, SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME),
      artifact,
      extraction
    )
    const verified = await verifySshRelayArtifactCacheEntry({
      entryPath: stagingPath,
      artifact,
      signal: activeSignal
    })
    await lock.assertOwned()
    activeSignal.throwIfAborted()
    await rename(stagingPath, entryPath)
    stagingPath = null
    return {
      ...verified,
      entryPath,
      archivePath: join(entryPath, artifact.archive.name),
      runtimeRoot: join(entryPath, 'runtime'),
      proofPath: join(entryPath, SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME)
    }
  } finally {
    if (stagingPath) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
    }
    await lock.release()
  }
}

export const SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS = Object.freeze({
  transactionTimeoutMs: TRANSACTION_TIMEOUT_MS,
  maximumIncrementalMemoryBytes: MAXIMUM_INCREMENTAL_MEMORY_BYTES
})
