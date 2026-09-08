import {
  MobileWebPackageAssetParamsSchema,
  isMobileWebPackageErrorCode
} from '../../../../shared/mobile-web/package-rpc-contract'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'
import { mobileWebPackageAssets } from '../mobile-web-package-assets'

export const MOBILE_WEB_PACKAGE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'mobileWeb.package.manifest',
    params: null,
    handler: async () => runPackageOperation(() => mobileWebPackageAssets.getManifest())
  }),
  defineMethod({
    name: 'mobileWeb.package.asset',
    params: MobileWebPackageAssetParamsSchema,
    handler: async (params, { connectionId, signal }) =>
      runPackageOperation(() =>
        mobileWebPackageAssets.getAssetChunk(params, { connectionId, signal })
      )
  }),
  defineMethod({
    name: 'mobileWeb.package.asset.gzip',
    params: MobileWebPackageAssetParamsSchema,
    handler: async (params, { connectionId, signal }) =>
      runPackageOperation(() =>
        mobileWebPackageAssets.getAssetGzipChunk(params, { connectionId, signal })
      )
  })
]

export async function runPackageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new InvalidArgumentError(
      isMobileWebPackageErrorCode(message) ? message : 'mobile_web_package_unavailable'
    )
  }
}
