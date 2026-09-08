import { Buffer } from 'buffer/'
import { serializeMobileWebManifestForBuildId } from '../../../src/shared/mobile-web/manifest-contract'
import type {
  MobileWebAsset,
  MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { MobileWebPackageStager } from './mobile-web-package-downloader'

export type MobileWebNativeStagingApi = {
  writeStagedAsset(
    hostIdentity: string,
    buildId: string,
    path: string,
    dataBase64: string
  ): Promise<void>
  commitGeneration(
    hostIdentity: string,
    buildId: string,
    manifestJson: string
  ): Promise<{ buildId: string }>
  abortGeneration(hostIdentity: string, buildId: string): Promise<void>
}

export class MobileWebNativeStagingAdapter implements MobileWebPackageStager<{ buildId: string }> {
  constructor(
    private readonly native: MobileWebNativeStagingApi,
    private readonly hostIdentity: string
  ) {}

  async writeAsset(buildId: string, asset: MobileWebAsset, bytes: Uint8Array): Promise<void> {
    await this.native.writeStagedAsset(
      this.hostIdentity,
      buildId,
      asset.path,
      Buffer.from(bytes).toString('base64')
    )
  }

  // The build id is the sha256 of the canonical manifest, so the store can authenticate both.
  async commit(manifest: MobileWebManifest): Promise<{ buildId: string }> {
    const committed = await this.native.commitGeneration(
      this.hostIdentity,
      manifest.buildId,
      serializeMobileWebManifestForBuildId(manifest)
    )
    if (committed.buildId !== manifest.buildId) {
      throw new Error('mobile_web_generation_commit_mismatch')
    }
    return committed
  }

  async abort(buildId: string): Promise<void> {
    await this.native.abortGeneration(this.hostIdentity, buildId)
  }
}
