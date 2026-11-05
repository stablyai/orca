import type { ArtifactCloudService } from '../../artifacts/artifact-cloud-service'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListItem,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactPublishResult,
  ArtifactPublishedLink,
  ArtifactWriteRequest
} from '../../../shared/artifacts'
import { LegacyWorkerTerminalSurface } from '../orchestration/terminal-authority/legacy-worker-terminal-surface'

export abstract class RuntimeArtifactOperations extends LegacyWorkerTerminalSurface {
  setArtifactService(service: ArtifactCloudService): void {
    this.artifacts.setService(service)
  }

  listArtifacts(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.artifacts.list(options)
  }

  getPublishedArtifactLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.artifacts.getPublishedLink(request)
  }

  shareArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.share(request)
  }

  publishArtifact(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.artifacts.publish(request)
  }

  updateArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.update(request)
  }

  unshareArtifact(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.unshare(request)
  }

  deleteArtifact(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.delete(id, options)
  }
}
