import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import {
  downloadSshRelayArtifact,
  type SshRelayArtifactDownloadResult
} from './ssh-relay-artifact-download'
import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

const DOWNLOAD_DIRECTORY_NAME = 'downloads'
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/

type DownloadStaging = Readonly<{
  cacheRoot: string
  directory: string
  archivePath: string
}>

function exactContentHex(artifact: SshRelaySelectedArtifact): string {
  const match = CONTENT_ID.exec(artifact.contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache population content ID must be an exact digest')
  }
  return match[1]
}

function exactArchiveName(artifact: SshRelaySelectedArtifact): string {
  const name = artifact.archive.name
  if (!name || name === '.' || name === '..' || basename(name) !== name || /[/\\]/.test(name)) {
    throw new Error('SSH relay artifact cache population archive name must be a basename')
  }
  return name
}

async function ownedDownloadDirectory(cacheRoot: string): Promise<{
  cacheRoot: string
  downloads: string
}> {
  const logicalRoot = resolve(cacheRoot)
  await mkdir(logicalRoot, { recursive: true, mode: 0o700 })
  const rootMetadata = await lstat(logicalRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('SSH relay artifact cache population root must be an owned directory')
  }
  const physicalRoot = await realpath(logicalRoot)
  const logicalDownloads = join(physicalRoot, DOWNLOAD_DIRECTORY_NAME)
  await mkdir(logicalDownloads, { recursive: true, mode: 0o700 })
  const downloadsMetadata = await lstat(logicalDownloads)
  if (!downloadsMetadata.isDirectory() || downloadsMetadata.isSymbolicLink()) {
    throw new Error('SSH relay artifact cache downloads path must be an owned directory')
  }
  const downloads = await realpath(logicalDownloads)
  if (dirname(downloads) !== physicalRoot || basename(downloads) !== DOWNLOAD_DIRECTORY_NAME) {
    throw new Error('SSH relay artifact cache downloads path must not traverse a link')
  }
  return { cacheRoot: physicalRoot, downloads }
}

async function createDownloadStaging(
  cacheRoot: string,
  artifact: SshRelaySelectedArtifact
): Promise<DownloadStaging> {
  const { cacheRoot: physicalRoot, downloads } = await ownedDownloadDirectory(cacheRoot)
  const prefix = `${exactContentHex(artifact)}.pending-`
  const logicalDirectory = await mkdtemp(join(downloads, prefix))
  try {
    const metadata = await lstat(logicalDirectory)
    const directory = await realpath(logicalDirectory)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      dirname(directory) !== downloads ||
      !basename(directory).startsWith(prefix)
    ) {
      throw new Error('SSH relay artifact cache download staging must be an exclusive directory')
    }
    return Object.freeze({
      cacheRoot: physicalRoot,
      directory,
      archivePath: join(directory, exactArchiveName(artifact))
    })
  } catch (error) {
    await rm(logicalDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function assertDownloadResult(
  result: SshRelayArtifactDownloadResult,
  artifact: SshRelaySelectedArtifact,
  archivePath: string
): void {
  if (
    result.destinationPath !== archivePath ||
    result.size !== artifact.archive.size ||
    result.sha256 !== artifact.archive.sha256
  ) {
    throw new Error('SSH relay artifact cache download result identity is inconsistent')
  }
}

function frozenEntry(
  entry: SshRelayArtifactCacheEntry,
  artifact: SshRelaySelectedArtifact
): Readonly<SshRelayArtifactCacheEntry> {
  if (entry.contentId !== artifact.contentId || entry.tupleId !== artifact.tupleId) {
    throw new Error('SSH relay artifact cache published entry identity is inconsistent')
  }
  return Object.freeze({ ...entry })
}

export type SshRelayArtifactCachePopulationOperations = Readonly<{
  download: typeof downloadSshRelayArtifact
  publish: typeof publishSshRelayArtifactCacheEntry
  acquireInUseLease: typeof acquireSshRelayArtifactCacheInUseLease
}>

const DEFAULT_OPERATIONS: SshRelayArtifactCachePopulationOperations = Object.freeze({
  download: downloadSshRelayArtifact,
  publish: publishSshRelayArtifactCacheEntry,
  acquireInUseLease: acquireSshRelayArtifactCacheInUseLease
})

export type SshRelayArtifactCachePopulation = Readonly<{
  artifact: SshRelaySelectedArtifact
  entry: Readonly<SshRelayArtifactCacheEntry>
  lease: SshRelayArtifactCacheInUseLease
}>

export async function populateSshRelayArtifactCache(
  {
    cacheRoot,
    artifact,
    signal
  }: {
    cacheRoot: string
    artifact: SshRelaySelectedArtifact
    signal?: AbortSignal
  },
  operations: SshRelayArtifactCachePopulationOperations = DEFAULT_OPERATIONS
): Promise<SshRelayArtifactCachePopulation> {
  signal?.throwIfAborted()
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot)) {
    throw new Error('SSH relay artifact cache population root must be absolute')
  }

  const staging = await createDownloadStaging(cacheRoot, artifact)
  let stagingRemoved = false
  try {
    const download = await operations.download({
      artifact,
      destinationPath: staging.archivePath,
      signal
    })
    assertDownloadResult(download, artifact, staging.archivePath)
    signal?.throwIfAborted()
    // Why: publication already re-hashes, strictly extracts, verifies, and atomically exposes the
    // complete tree; this composition must not create a weaker or duplicate extraction path.
    const published = await operations.publish({
      cacheRoot: staging.cacheRoot,
      artifact,
      archivePath: staging.archivePath,
      signal
    })
    const entry = frozenEntry(published, artifact)
    await rm(staging.directory, { recursive: true })
    stagingRemoved = true
    signal?.throwIfAborted()

    const lease = await operations.acquireInUseLease({
      cacheRoot: staging.cacheRoot,
      entry,
      signal
    })
    try {
      signal?.throwIfAborted()
      return Object.freeze({ artifact, entry, lease })
    } catch (error) {
      await lease.release().catch(() => {})
      throw error
    }
  } finally {
    if (!stagingRemoved) {
      await rm(staging.directory, { recursive: true, force: true }).catch(() => {})
    }
  }
}
