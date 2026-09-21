import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListItem,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'

export class RuntimeArtifactController {
  private service: ArtifactCloudService | null = null

  setService(service: ArtifactCloudService): void {
    this.service = service
  }

  list(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.requireService().list(options)
  }

  getPublishedLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.requireService().getPublishedLink(request)
  }

  share(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.requireService().share(request)
  }

  publish(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.requireService().publish(request)
  }

  update(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.requireService().update(request)
  }

  unshare(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.requireService().unshare(request)
  }

  delete(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.requireService().delete(id, options)
  }

  private requireService(): ArtifactCloudService {
    if (!this.service) {
      throw new Error('Artifact service is unavailable.')
    }
    return this.service
  }
}
