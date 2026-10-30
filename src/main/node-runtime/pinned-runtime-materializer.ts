import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import {
  downloadVerifiedArchive,
  extractRuntimeArchive,
  ReleaseMismatchError
} from './runtime-archive-download'
import { findOrcadCachePath } from './orcad-cache-path'
import { orcadNodeRuntimeExecutable } from '../../shared/orcad-artifacts'
import { nodeDistMirrorUrl } from '../../shared/node-dist-mirror'
import { configuredNodeDistMirror } from './node-dist-mirror-setting'
import {
  NODE_RUNTIME_PIN,
  pinnedNodeRuntimeAsset,
  nodeRuntimeExecutablePath,
  nodeRuntimeReleaseUrl,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'
import { errorMessage } from '../../shared/error-message'

export type PinnedRuntimeMaterializeOptions = {
  fetcher?: MainHttpClient['fetch']
  signal?: AbortSignal
  /** Empty disables retries. */
  retryDelaysMs?: readonly number[]
  /** Give up, without retrying, when no response arrives in time (a firewall that drops packets). */
  connectTimeoutMs?: number
}

export type PinnedRuntimeArchive = {
  label: string
  url: string
  archiveSha256: string
  /** Defaults to 200 MiB. */
  maxArchiveBytes?: number
}

export type PinnedRuntimeExecutable = PinnedRuntimeArchive & {
  executableSha256: string
  member: string
  isWindows: boolean
  /** Repairs use attempt > 0 to publish beside existing readers. */
  cachePath: (attempt: number) => string
}

function archiveName(archive: PinnedRuntimeArchive): string {
  return basename(new URL(archive.url).pathname)
}

/** Cache archives by pin; verify their hash on every use. */
export async function materializeVerifiedRuntimeArchive(
  archive: PinnedRuntimeArchive,
  cacheDir: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  options.signal?.throwIfAborted()
  await mkdir(cacheDir, { recursive: true })
  const name = archiveName(archive)
  const cached = await findOrcadCachePath(
    (attempt) => join(cacheDir, `${attempt ? `repair-${attempt}-` : ''}${name}`),
    async (path) => (await fileSha256(path)) === archive.archiveSha256
  )
  if (cached.verified) {
    return cached.path
  }
  const temporaryDir = join(cacheDir, `.download-${process.pid}-${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  try {
    const downloaded = join(temporaryDir, name)
    await downloadVerifiedArchive(
      archive,
      downloaded,
      options.fetcher ?? getMainHttpClient().fetch,
      options.signal,
      options.retryDelaysMs,
      undefined,
      options.connectTimeoutMs
    ).catch((error: unknown) => {
      throw unreachableArchiveError(archive, cached.path, error, options.signal)
    })
    options.signal?.throwIfAborted()
    await publishVerified(
      downloaded,
      cached.path,
      archive.archiveSha256,
      `${archive.label} archive`
    )
    return cached.path
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

/** Attribute download failures to this computer and expose the hash-verified offline cache path. */
function unreachableArchiveError(
  archive: PinnedRuntimeArchive,
  cachePath: string,
  error: unknown,
  signal: AbortSignal | undefined
): unknown {
  const localFailure = error instanceof Error && 'code' in error && typeof error.code === 'string'
  if (signal?.aborted || error instanceof ReleaseMismatchError || localFailure) {
    return error
  }
  const cause = errorMessage(error)
  return new DesktopDownloadUnreachableError(
    `This computer couldn't download ${archive.label} from ${archive.url} (${cause}). ` +
      `Orca uploads ${archive.label} to the host from this computer, so the host doesn't need ` +
      `internet access, but this computer must reach that address once. Check this computer's ` +
      `network connection or proxy and connect again, set a mirror in Settings > Advanced > ` +
      `Network > Node.js download mirror, or download that file on another machine ` +
      `and copy it to ${cachePath}`,
    `${archive.url}: ${cause}`,
    error
  )
}

export class DesktopDownloadUnreachableError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    cause: unknown
  ) {
    super(message, { cause })
    this.name = 'DesktopDownloadUnreachableError'
  }
}

export async function materializeCachedRuntimeExecutable(
  runtime: PinnedRuntimeExecutable,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  options.signal?.throwIfAborted()
  const cached = await findOrcadCachePath(
    runtime.cachePath,
    async (path) => (await fileSha256(path)) === runtime.executableSha256
  )
  const runtimePath = cached.path
  if (cached.verified) {
    if (!runtime.isWindows) {
      await chmod(runtimePath, 0o755)
    }
    return runtimePath
  }
  const runtimeDir = join(runtimePath, '..')
  await mkdir(runtimeDir, { recursive: true })
  const temporaryDir = join(runtimeDir, `.download-${process.pid}-${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  try {
    const archivePath = join(temporaryDir, archiveName(runtime))
    await downloadVerifiedArchive(
      runtime,
      archivePath,
      options.fetcher ?? getMainHttpClient().fetch,
      options.signal,
      options.retryDelaysMs
    )
    options.signal?.throwIfAborted()
    const extractedDir = join(temporaryDir, 'extracted')
    await mkdir(extractedDir)
    const result = await extractRuntimeArchive(runtime, archivePath, extractedDir, options.signal)
    options.signal?.throwIfAborted()
    if (result.code !== 0) {
      throw new Error(
        `${runtime.label} archive extraction failed: ${result.stderr || result.stdout}`
      )
    }
    const executable = join(extractedDir, ...runtime.member.split('/'))
    await verifyFileSha256(executable, runtime.executableSha256, `${runtime.label} executable`)
    if (!runtime.isWindows) {
      await chmod(executable, 0o755)
    }
    options.signal?.throwIfAborted()
    await publishVerified(
      executable,
      runtimePath,
      runtime.executableSha256,
      `cached ${runtime.label} executable`
    )
    return runtimePath
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

/** Hard-link publication preserves a concurrent winner instead of replacing its bytes. */
async function publishVerified(
  source: string,
  destination: string,
  sha256: string,
  label: string
): Promise<void> {
  try {
    await link(source, destination)
  } catch (error) {
    if ((await fileSha256(destination)) !== sha256) {
      throw new Error(`${label} cache entry is unavailable or corrupted: ${destination}`, {
        cause: error
      })
    }
  }
  await verifyFileSha256(destination, sha256, label)
}

function nodeRuntimeArchive(target: NodeRuntimeTarget): PinnedRuntimeArchive {
  const asset = pinnedNodeRuntimeAsset(target)
  return {
    label: 'Node',
    url: nodeRuntimeReleaseUrl(asset.source, asset.archive),
    archiveSha256: asset.archiveSha256
  }
}

async function withNodeDistMirror<T>(
  target: NodeRuntimeTarget,
  options: PinnedRuntimeMaterializeOptions,
  run: (archive: PinnedRuntimeArchive, options: PinnedRuntimeMaterializeOptions) => Promise<T>
): Promise<T> {
  const archive = nodeRuntimeArchive(target)
  const asset = pinnedNodeRuntimeAsset(target)
  // Mirrors host only the official tree; unofficial builds have one source URL.
  const mirror = asset.source === 'official' ? configuredNodeDistMirror() : null
  if (!mirror) {
    return run(archive, options)
  }
  const mirrorUrl = nodeDistMirrorUrl(mirror, NODE_RUNTIME_PIN.version, asset.archive)
  try {
    // Do not delay official fallback with mirror retries.
    return await run({ ...archive, url: mirrorUrl }, { ...options, retryDelaysMs: [] })
  } catch (mirrorError) {
    if (options.signal?.aborted) {
      throw mirrorError
    }
    return run(archive, options).catch((error: unknown) => {
      // Combine network failures only; cancellation/local errors retain their own identity.
      if (options.signal?.aborted || !(error instanceof DesktopDownloadUnreachableError)) {
        throw error
      }
      const mirrorReason =
        mirrorError instanceof DesktopDownloadUnreachableError
          ? mirrorError.reason
          : `${mirrorUrl}: ${errorMessage(mirrorError)}`
      throw new DesktopDownloadUnreachableError(
        `${errorMessage(error)} (the mirror ${mirrorReason} failed too)`,
        `${mirrorReason}; ${errorReason(error)}`,
        error
      )
    })
  }
}

function errorReason(error: unknown): string {
  return error instanceof DesktopDownloadUnreachableError ? error.reason : errorMessage(error)
}

export function materializeNodeRuntimeArchive(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  return withNodeDistMirror(target, options, (archive, download) =>
    materializeVerifiedRuntimeArchive(archive, nodeRuntimeArchiveDir(cacheRoot), download)
  )
}

export function nodeRuntimeArchiveCachePath(target: NodeRuntimeTarget, cacheRoot: string): string {
  return join(nodeRuntimeArchiveDir(cacheRoot), pinnedNodeRuntimeAsset(target).archive)
}

function nodeRuntimeArchiveDir(cacheRoot: string): string {
  return join(cacheRoot, 'node', 'archives')
}

/** Content-keyed executable cache for hosts unable to extract archives, e.g. Windows SSH vault reads. */
export function materializeCachedNodeRuntime(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  const asset = pinnedNodeRuntimeAsset(target)
  const executableName = basename(orcadNodeRuntimeExecutable(target))
  return withNodeDistMirror(target, options, (archive, download) =>
    materializeCachedRuntimeExecutable(
      {
        ...archive,
        executableSha256: asset.executableSha256,
        member: nodeRuntimeExecutablePath(target, asset.archive),
        isWindows: target.startsWith('win32-'),
        cachePath: (attempt) =>
          join(
            cacheRoot,
            'node',
            asset.executableSha256,
            `${attempt ? `repair-${attempt}-` : ''}${executableName}`
          )
      },
      download
    )
  )
}

export async function verifyFileSha256(
  path: string,
  expected: string,
  label: string,
  signal?: AbortSignal
): Promise<void> {
  const actual = await fileSha256(path, signal)
  signal?.throwIfAborted()
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual ?? 'missing'}`)
  }
}

export async function fileSha256(path: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
