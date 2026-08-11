import type {
  ArtifactListItem,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import { artifactRequest, artifactWriteBody } from './artifact-cloud-request'
import {
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent,
  removeArtifactCreateIntent
} from './artifact-create-intent-store'
import {
  type ArtifactShareScope,
  getArtifactShareRecord,
  refreshArtifactShareRecordExpiration,
  removeArtifactShareRecords,
  saveArtifactShareRecord
} from './artifact-share-record-store'

type ArtifactCreateResponse = ArtifactListItem & { editToken: string }

type ArtifactCreateOutcome = {
  editToken: string
  result: ArtifactPublishResult
}

function artifactWriteBodiesMatch(
  left: ReturnType<typeof artifactWriteBody>,
  right: ReturnType<typeof artifactWriteBody>
): boolean {
  return (
    left.content === right.content &&
    left.contentType === right.contentType &&
    left.fileName === right.fileName &&
    left.title === right.title
  )
}

type ArtifactPublishAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

function artifactOperationQueueKey(
  kind: 'source' | 'slug',
  auth: Pick<ArtifactPublishAuthContext, 'profileId' | 'scope'>,
  identity: string
): string {
  return JSON.stringify([
    kind,
    auth.profileId,
    auth.scope.cloudUserId,
    auth.scope.cloudProfileId,
    auth.scope.cloudOrganizationId,
    auth.scope.apiOrigin,
    identity
  ])
}

export class ArtifactPublisher {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly userDataPath: string) {}

  async share(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactListItem> {
    return this.runForSource(request.sourceKey, auth, async () => {
      auth.assertCurrent()
      return (await this.create(request, token, apiUrl, auth, idempotencyKey)).result.item
    })
  }

  publish(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactPublishResult> {
    return this.runForSource(request.sourceKey, auth, async () => {
      auth.assertCurrent()
      const pending = getArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      if (pending) {
        const created = await this.create(request, token, apiUrl, auth, idempotencyKey)
        if (artifactWriteBodiesMatch(pending.body, artifactWriteBody(request))) {
          return created.result
        }
        const item = await this.updateExisting(request, token, apiUrl, auth, {
          slug: created.result.item.artifact.slug,
          editToken: created.editToken
        })
        return { change: 'created', item }
      }
      const record = getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      if (record) {
        try {
          const item = await this.updateExisting(request, token, apiUrl, auth, record)
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
      return (await this.create(request, token, apiUrl, auth, idempotencyKey)).result
    })
  }

  runForSource<T>(
    sourceKey: string,
    auth: Pick<ArtifactPublishAuthContext, 'profileId' | 'scope'>,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runSerialized(artifactOperationQueueKey('source', auth, sourceKey), operation)
  }

  runForSlug<T>(
    slug: string,
    auth: Pick<ArtifactPublishAuthContext, 'profileId' | 'scope'>,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runSerialized(artifactOperationQueueKey('slug', auth, slug), operation)
  }

  private updateExisting(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    record: { slug: string; editToken: string }
  ): Promise<ArtifactListItem> {
    return this.runForSlug(record.slug, auth, async () => {
      auth.assertCurrent()
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
      return item
    })
  }

  private async create(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPublishAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactCreateOutcome> {
    const intent = getOrCreateArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      request.sourceKey,
      auth.scope,
      idempotencyKey,
      artifactWriteBody(request)
    )
    const response = await artifactRequest<ArtifactCreateResponse>(apiUrl, token, '', {
      method: 'POST',
      body: intent.body,
      idempotencyKey: intent.idempotencyKey
    })
    auth.assertCurrent()
    saveArtifactShareRecord(auth.profileId, this.userDataPath, request.sourceKey, {
      slug: response.artifact.slug,
      editToken: response.editToken,
      shareUrl: response.shareUrl,
      expiresAt: response.artifact.expiresAt,
      ...auth.scope
    })
    removeArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      request.sourceKey,
      auth.scope,
      intent.idempotencyKey
    )
    return {
      editToken: response.editToken,
      result: {
        change: 'created',
        item: { artifact: response.artifact, shareUrl: response.shareUrl }
      }
    }
  }

  private async runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = previous.catch(() => {})
    const current = ready.then(() => released)
    this.queues.set(key, current)
    await ready
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
