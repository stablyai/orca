import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MobileWebPackageManifestResponseSchema
} from '../../../src/shared/mobile-web/package-rpc-contract'
import type { MobileWebManifest } from '../../../src/shared/mobile-web/manifest-contract'
import {
  serializeMobileWebManifestForBuildId,
  supportsMobileWebBridgeVersion
} from '../../../src/shared/mobile-web/manifest-contract'
import { clampRangeBytes, downloadAssetChunks } from './mobile-web-package-chunk-pipeline'
import {
  MobileWebPackageDownloadError,
  requestMobileWebPackageResult,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-download-contract'

const MOBILE_WEB_PACKAGE_MANIFEST_CUTOVER_RETRIES = 4
const MOBILE_WEB_PACKAGE_MANIFEST_CUTOVER_BACKOFF_MS = 250

export {
  MOBILE_WEB_PACKAGE_DOWNLOAD_ERROR_CODES,
  MobileWebPackageDownloadError,
  mobileWebPackageDownloadFailureCode,
  requestMobileWebPackageResult,
  type MobileWebPackageDownloadErrorCode,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-download-contract'

export type MobileWebPackageDownloadProgress = {
  phase: 'downloading' | 'verifying' | 'activating'
  completedBytes: number
  totalBytes: number
}

type DownloadMobileWebPackageOptions = {
  shellBridgeVersion: number
  signal?: AbortSignal
  useGzip?: boolean
  /** Chunk reads kept in flight at once. One round trip per 48 KiB otherwise caps throughput. */
  maxConcurrentRequests?: number
  /** Bytes per gzip read. Only send above chunkBytes when the host advertises range reads. */
  rangeBytes?: number
  onProgress?: (progress: MobileWebPackageDownloadProgress) => void
}

type DownloadMobileWebPackageWithReuseOptions = DownloadMobileWebPackageOptions & {
  reuseVerifiedBuild: (buildId: string) => boolean | Promise<boolean>
}

type DownloadedMobileWebPackage<TCommit> = {
  manifest: MobileWebManifest
  commit: TCommit
  reusedVerifiedBuild: false
}

type ReusedOrDownloadedMobileWebPackage<TCommit> =
  | DownloadedMobileWebPackage<TCommit>
  | {
      manifest: MobileWebManifest
      commit: null
      reusedVerifiedBuild: true
    }

export function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageWithReuseOptions
): Promise<ReusedOrDownloadedMobileWebPackage<TCommit>>

export function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageOptions
): Promise<DownloadedMobileWebPackage<TCommit>>

export async function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageOptions & {
    reuseVerifiedBuild?: (buildId: string) => boolean | Promise<boolean>
  }
): Promise<ReusedOrDownloadedMobileWebPackage<TCommit>> {
  throwIfAborted(options.signal)
  const manifestResponse = await readManifestAcrossCutovers(request, options.signal)
  throwIfAborted(options.signal)
  const parsedManifest = MobileWebPackageManifestResponseSchema.safeParse(manifestResponse)
  if (!parsedManifest.success) {
    throw new MobileWebPackageDownloadError('invalid_manifest')
  }
  const { manifest, chunkBytes } = parsedManifest.data
  options.onProgress?.({
    phase: 'downloading',
    completedBytes: 0,
    totalBytes: manifest.totalBytes
  })
  if (sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(manifest))) !== manifest.buildId) {
    throw new MobileWebPackageDownloadError('invalid_manifest')
  }
  if (!supportsMobileWebBridgeVersion(manifest.bridge, options.shellBridgeVersion)) {
    throw new MobileWebPackageDownloadError('incompatible_bridge')
  }
  if (await options.reuseVerifiedBuild?.(manifest.buildId)) {
    throwIfAborted(options.signal)
    return { manifest, commit: null, reusedVerifiedBuild: true }
  }
  throwIfAborted(options.signal)

  let stagingStarted = false
  try {
    await stager.begin(manifest)
    stagingStarted = true
    let completedBytes = 0
    await downloadAssetChunks({
      request,
      stager,
      manifest,
      chunkBytes,
      signal: options.signal,
      useGzip: options.useGzip ?? false,
      rangeBytes: options.useGzip ? clampRangeBytes(chunkBytes, options.rangeBytes) : chunkBytes,
      maxConcurrentRequests:
        options.maxConcurrentRequests ?? MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
      onChunkWritten: (writtenBytes) => {
        completedBytes += writtenBytes
        options.onProgress?.({
          phase: 'downloading',
          completedBytes,
          totalBytes: manifest.totalBytes
        })
      }
    })
    throwIfAborted(options.signal)
    options.onProgress?.({
      phase: 'verifying',
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes
    })
    const commit = await stager.commit(manifest)
    options.onProgress?.({
      phase: 'activating',
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes
    })
    stagingStarted = false
    return { manifest, commit, reusedVerifiedBuild: false }
  } catch (error) {
    if (stagingStarted) {
      await stager.abort().catch(() => {})
    }
    if (error instanceof MobileWebPackageDownloadError) {
      throw error
    }
    throw new MobileWebPackageDownloadError('staging_failed')
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MobileWebPackageDownloadError('cancelled')
  }
}

// Why: the manifest read is the one request a cutover can kill before any chunk exists to retry,
// and nothing upstream re-runs the download when connState never changed.
async function readManifestAcrossCutovers(
  request: MobileWebPackageRequest,
  signal: AbortSignal | undefined
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestMobileWebPackageResult(request, 'mobileWeb.package.manifest')
    } catch (error) {
      if (
        !(error instanceof MobileWebPackageDownloadError) ||
        !error.retryable ||
        attempt >= MOBILE_WEB_PACKAGE_MANIFEST_CUTOVER_RETRIES
      ) {
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MOBILE_WEB_PACKAGE_MANIFEST_CUTOVER_BACKOFF_MS * (attempt + 1))
      )
      throwIfAborted(signal)
    }
  }
}
