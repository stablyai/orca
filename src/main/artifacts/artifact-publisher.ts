import type {
  ArtifactListItem,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import {
  artifactRequest,
  type ArtifactWriteBody,
  artifactWriteBody
} from './artifact-cloud-request'
import {
  type ArtifactCreateIntent,
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
  intent: ArtifactCreateIntent
  result: ArtifactPublishResult
}

function artifactWriteBodiesMatch(left: ArtifactWriteBody, right: ArtifactWriteBody): boolean {
  return (
    left.content === right.content &&
    left.contentType === right.contentType &&
    left.fileName === right.fileName &&
    left.title === right.title
  )
}

function discardsCreateIntent(error: unknown): boolean {
  return (
    error instanceof OrcaCloudRequestError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    ![408, 409, 425, 429].includes(error.statusCode)
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
      const pending = getArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      const created = await this.create(request, token, apiUrl, auth, idempotencyKey, pending)
      if (pending && !artifactWriteBodiesMatch(pending.body, artifactWriteBody(request))) {
        const item = await this.updateExisting(request, token, apiUrl, auth, {
          slug: created.result.item.artifact.slug,
          editToken: created.editToken
        })
        this.removeCreateIntent(request, auth, created.intent)
        return item
      }
      this.removeCreateIntent(request, auth, created.intent)
      return created.result.item
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
        const created = await this.create(request, token, apiUrl, auth, idempotencyKey, pending)
        if (artifactWriteBodiesMatch(pending.body, artifactWriteBody(request))) {
          this.removeCreateIntent(request, auth, created.intent)
          return created.result
        }
        const item = await this.updateExisting(request, token, apiUrl, auth, {
          slug: created.result.item.artifact.slug,
          editToken: created.editToken
        })
        this.removeCreateIntent(request, auth, created.intent)
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
      const created = await this.create(request, token, apiUrl, auth, idempotencyKey, null)
      this.removeCreateIntent(request, auth, created.intent)
      return created.result
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
    idempotencyKey: string,
    pending: ArtifactCreateIntent | null
  ): Promise<ArtifactCreateOutcome> {
    const replaying = pending !== null
    const intent =
      pending ??
      getOrCreateArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope,
        idempotencyKey,
        artifactWriteBody(request)
      )
    let response: ArtifactCreateResponse
    try {
      response = await artifactRequest<ArtifactCreateResponse>(apiUrl, token, '', {
        method: 'POST',
        body: intent.body,
        idempotencyKey: intent.idempotencyKey
      })
    } catch (error) {
      // A replay may outlive its server receipt, so never abandon a possibly committed artifact.
      if (!replaying && discardsCreateIntent(error)) {
        removeArtifactCreateIntent(
          auth.profileId,
          this.userDataPath,
          request.sourceKey,
          auth.scope,
          intent.idempotencyKey
        )
      }
      throw error
    }
    auth.assertCurrent()
    saveArtifactShareRecord(auth.profileId, this.userDataPath, request.sourceKey, {
      slug: response.artifact.slug,
      editToken: response.editToken,
      shareUrl: response.shareUrl,
      expiresAt: response.artifact.expiresAt,
      ...auth.scope
    })
    return {
      editToken: response.editToken,
      intent,
      result: {
        change: 'created',
        item: { artifact: response.artifact, shareUrl: response.shareUrl }
      }
    }
  }

  private removeCreateIntent(
    request: ArtifactWriteRequest,
    auth: ArtifactPublishAuthContext,
    intent: ArtifactCreateIntent
  ): void {
    removeArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      request.sourceKey,
      auth.scope,
      intent.idempotencyKey
    )
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
