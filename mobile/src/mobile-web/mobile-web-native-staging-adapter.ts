import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import { serializeMobileWebManifestForBuildId } from '../../../src/shared/mobile-web/manifest-contract'
import type {
  MobileWebAsset,
  MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { MobileWebPackageStager } from './mobile-web-package-downloader'

export type MobileWebNativeStagingApi = {
  beginStage(
    hostIdentity: string,
    manifestJson: string,
    canonicalManifestJson: string
  ): Promise<string>
  writeAssetChunk(
    stageId: string,
    path: string,
    offset: number,
    dataBase64: string,
    chunkSha256: string
  ): Promise<void>
  finishAsset(stageId: string, path: string): Promise<void>
  commitStage(stageId: string): Promise<{ buildId: string }>
  abortStage(stageId: string): Promise<void>
}

export class MobileWebNativeStagingAdapter implements MobileWebPackageStager<{ buildId: string }> {
  private stageId: string | null = null

  constructor(
    private readonly native: MobileWebNativeStagingApi,
    private readonly hostIdentity: string
  ) {}

  async begin(manifest: MobileWebManifest): Promise<void> {
    if (this.stageId) {
      throw new Error('mobile_web_stage_already_started')
    }
    this.stageId = await this.native.beginStage(
      this.hostIdentity,
      JSON.stringify(manifest),
      serializeMobileWebManifestForBuildId(manifest)
    )
  }

  async writeAssetChunk(asset: MobileWebAsset, offset: number, bytes: Uint8Array): Promise<void> {
    const stageId = this.requireStage()
    await this.native.writeAssetChunk(
      stageId,
      asset.path,
      offset,
      Buffer.from(bytes).toString('base64'),
      Buffer.from(sha256(bytes)).toString('hex')
    )
  }

  async finishAsset(asset: MobileWebAsset): Promise<void> {
    await this.native.finishAsset(this.requireStage(), asset.path)
  }

  async commit(manifest: MobileWebManifest): Promise<{ buildId: string }> {
    const committed = await this.native.commitStage(this.requireStage())
    if (committed.buildId !== manifest.buildId) {
      throw new Error('mobile_web_stage_commit_mismatch')
    }
    this.stageId = null
    return committed
  }

  async abort(): Promise<void> {
    const stageId = this.stageId
    this.stageId = null
    if (stageId) {
      await this.native.abortStage(stageId)
    }
  }

  private requireStage(): string {
    if (!this.stageId) {
      throw new Error('mobile_web_stage_not_started')
    }
    return this.stageId
  }
}
