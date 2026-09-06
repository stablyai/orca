import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  isMobileWebPackageErrorCode,
  type MobileWebPackageErrorCode
} from '../../../src/shared/mobile-web/package-rpc-contract'
import type {
  MobileWebAsset,
  MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { RpcResponse } from '../transport/types'

export const MOBILE_WEB_PACKAGE_DOWNLOAD_ERROR_CODES = [
  'cancelled',
  'host_error',
  'host_forbidden',
  'host_method_unavailable',
  'host_rejected_request',
  'host_runtime_failure',
  'invalid_manifest',
  'incompatible_bridge',
  'invalid_chunk',
  'asset_integrity_failed',
  'staging_failed'
] as const

export type MobileWebPackageDownloadErrorCode =
  | (typeof MOBILE_WEB_PACKAGE_DOWNLOAD_ERROR_CODES)[number]
  | MobileWebPackageErrorCode

export class MobileWebPackageDownloadError extends Error {
  constructor(
    readonly code: MobileWebPackageDownloadErrorCode,
    /** The same request on a fresh logical session can still succeed. */
    readonly retryable = false
  ) {
    super(code)
    this.name = 'MobileWebPackageDownloadError'
  }
}

export function mobileWebPackageDownloadFailureCode(error: unknown): string {
  return error instanceof MobileWebPackageDownloadError ? error.code : 'native_session_error'
}

export type MobileWebPackageRequest = (method: string, params?: unknown) => Promise<RpcResponse>

export type MobileWebPackageStager<TCommit> = {
  begin(manifest: MobileWebManifest): Promise<void>
  writeAssetChunk(asset: MobileWebAsset, offset: number, bytes: Uint8Array): Promise<void>
  finishAsset(asset: MobileWebAsset): Promise<void>
  commit(manifest: MobileWebManifest): Promise<TCommit>
  abort(): Promise<void>
}

export async function requestMobileWebPackageResult(
  request: MobileWebPackageRequest,
  method: string,
  params?: unknown
): Promise<unknown> {
  let response: RpcResponse
  try {
    response = await request(method, params)
  } catch (error) {
    // Why: a relay/direct cutover rejects in-flight requests without changing connState, so no
    // upstream effect re-runs the download. Mark it so the caller can re-issue on the new session.
    throw new MobileWebPackageDownloadError(
      'host_error',
      isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
    )
  }
  if (!response.ok) {
    const message = response.error.message
    throw new MobileWebPackageDownloadError(
      isMobileWebPackageErrorCode(message)
        ? message
        : mobileWebPackageHostFailureCode(response.error.code)
    )
  }
  return response.result
}

function mobileWebPackageHostFailureCode(code: string): MobileWebPackageDownloadErrorCode {
  switch (code) {
    case 'forbidden':
    case 'unauthorized':
      return 'host_forbidden'
    case 'method_not_found':
    case 'method_not_supported':
      return 'host_method_unavailable'
    case 'invalid_argument':
      return 'host_rejected_request'
    case 'runtime_error':
      return 'host_runtime_failure'
    default:
      return 'host_error'
  }
}
