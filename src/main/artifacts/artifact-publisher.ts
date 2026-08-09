import type {
  ArtifactListItem,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import { artifactRequest, artifactWriteBody } from './artifact-cloud-request'
import {
  type ArtifactShareScope,
  getArtifactShareRecord,
  refreshArtifactShareRecordExpiration,
  removeArtifactShareRecords,
  saveArtifactShareRecord
} from './artifact-share-record-store'

type ArtifactCreateResponse = ArtifactListItem & { editToken: string }

type ArtifactPublishAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

export class ArtifactPublisher {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly userDataPath: string) {}

  publish(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactPublishResult> {
    const queueKey = JSON.stringify([auth.profileId, auth.scope, request.sourceKey])
    return this.runSerialized(queueKey, async () => {
      auth.assertCurrent()
      const record = getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      if (record) {
        try {
          const item = await artifactRequest<ArtifactListItem>(apiUrl, token, `/${record.slug}`, {
            method: 'PUT',
            editToken: record.editToken,
            body: artifactWriteBody(request)
          })
          auth.assertCurrent()
          refreshArtifactShareRecordExpiration(
            auth.profileId,
            this.userDataPath,
            request.sourceKey,
            auth.scope,
            record,
            item.artifact.expiresAt
          )
          return { change: 'updated', item }
        } catch (error) {
          if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 404) {
            throw error
          }
          auth.assertCurrent()
          removeArtifactShareRecords(auth.profileId, this.userDataPath, auth.scope, {
            sourceKey: request.sourceKey,
            slug: record.slug
          })
        }
      }
      return this.create(request, token, apiUrl, auth, idempotencyKey)
    })
  }

  private async create(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactPublishResult> {
    const response = await artifactRequest<ArtifactCreateResponse>(apiUrl, token, '', {
      method: 'POST',
      body: artifactWriteBody(request),
      idempotencyKey
    })
    auth.assertCurrent()
    saveArtifactShareRecord(auth.profileId, this.userDataPath, request.sourceKey, {
      slug: response.artifact.slug,
      editToken: response.editToken,
      shareUrl: response.shareUrl,
      expiresAt: response.artifact.expiresAt,
      ...auth.scope
    })
    return {
      change: 'created',
      item: { artifact: response.artifact, shareUrl: response.shareUrl }
    }
  }

  private async runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => {}).then(() => released)
    this.queues.set(key, current)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.queues.get(key) === current) {
        this.queues.delete(key)
      }
    }
  }
}
