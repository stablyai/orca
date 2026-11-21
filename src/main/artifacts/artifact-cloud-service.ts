import { requiresExplicitCloudServiceUrl } from '../orca-profiles/cloud-auth/profile-cloud-server-preferences'
import { randomUUID } from 'node:crypto'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactListItem,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts/artifacts'
import { assertArtifactSharingAllowed } from '../../shared/artifacts/artifact-sharing-gate'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { prepareArtifactCloudUse } from '../orca-profiles/cloud-auth/profile-artifact-cloud-cleanup'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import {
  allowsArtifactCloudAuthOverride,
  resolveArtifactCloudApiUrl
} from './artifact-cloud-config'
import {
  getArtifactShareRecord,
  refreshArtifactShareRecordExpiration,
  removeArtifactShareRecords
} from './artifact-share-record-store'
import { artifactRequest, artifactWriteBody } from './artifact-cloud-request'
import { ArtifactPublisher } from './artifact-publisher'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { isTeamFeatureBlocked } from '../orca-profiles/cloud-auth/active-team-capabilities'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../shared/orca-profiles/orca-cloud-team-policy'

import {
  type ArtifactAuthContext,
  createArtifactRateLimitAllowance,
  explicitTokenAuthContext,
  storedSessionAuthContext
} from './artifact-cloud-auth-context'

async function deleteArtifactRequest(
  apiUrl: string,
  token: string,
  path: string,
  auth: ArtifactAuthContext,
  editToken?: string
): Promise<void> {
  try {
    await artifactRequest<void>(apiUrl, token, path, {
      method: 'DELETE',
      rateLimitReplay: auth.rateLimitReplay,
      ...(editToken ? { editToken } : {})
    })
  } catch (error) {
    if (
      !(error instanceof OrcaCloudRequestError) ||
      error.statusCode !== 404 ||
      error.errorCode !== 'artifact_not_found'
    ) {
      throw error
    }
  }
}

export class ArtifactCloudService {
  private readonly publisher: ArtifactPublisher

  /** Read the publish gate per request; revoking old links remains available when publishing is disabled. */
  constructor(
    private readonly userDataPath: string,
    private readonly isSharingEnabled: () => boolean
  ) {
    this.publisher = new ArtifactPublisher(userDataPath)
  }

  list(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.withAuth(options, async (token, apiUrl, auth) => {
      const query = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''
      return artifactRequest<ArtifactListPage>(apiUrl, token, query, {
        rateLimitReplay: auth.rateLimitReplay
      })
    })
  }

  getPublishedLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.withAuth(request, async (_token, _apiUrl, auth) => {
      const record = await getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      // The read waited on the disk; a sign-out meanwhile must not hand back its link.
      auth.assertCurrent()
      return record ? { shareUrl: record.shareUrl } : null
    })
  }

  // Keep gate failures asynchronous for callers’ promise chains.
  async share(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    const idempotencyKey = randomUUID()
    return this.withSharingAuth(request, (token, apiUrl, auth) =>
      this.publisher.share(request, token, apiUrl, auth, idempotencyKey)
    )
  }

  async publish(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    const idempotencyKey = randomUUID()
    return this.withSharingAuth(request, (token, apiUrl, auth) =>
      this.publisher.publish(request, token, apiUrl, auth, idempotencyKey)
    )
  }

  async update(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.withSharingAuth(request, (token, apiUrl, auth) =>
      this.publisher.runForSource(request.sourceKey, auth, async () => {
        auth.assertCurrent()
        const record = await getArtifactShareRecord(
          auth.profileId,
          this.userDataPath,
          request.sourceKey,
          auth.scope
        )
        if (!record) {
          throw new Error('This file has not been shared from the active Orca profile.')
        }
        return this.publisher.runForSlug(record.slug, auth, async () => {
          auth.assertCanSend()
          const response = await artifactRequest<ArtifactListItem>(
            apiUrl,
            token,
            `/${record.slug}`,
            {
              method: 'PUT',
              editToken: record.editToken,
              body: artifactWriteBody(request),
              rateLimitReplay: auth.rateLimitReplay
            }
          )
          await refreshArtifactShareRecordExpiration(
            auth.profileId,
            this.userDataPath,
            request.sourceKey,
            auth.scope,
            record,
            response.artifact.expiresAt,
            auth.assertCurrent
          )
          return response
        })
      })
    )
  }

  unshare(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.withAuth(request, (token, apiUrl, auth) =>
      this.publisher.runForSource(request.sourceKey, auth, async () => {
        auth.assertCurrent()
        const record = await getArtifactShareRecord(
          auth.profileId,
          this.userDataPath,
          request.sourceKey,
          auth.scope
        )
        if (!record) {
          throw new Error('This file has not been shared from the active Orca profile.')
        }
        return this.publisher.runForSlug(record.slug, auth, async () => {
          auth.assertCanSend()
          await deleteArtifactRequest(apiUrl, token, `/${record.slug}`, auth, record.editToken)
          await removeArtifactShareRecords(
            auth.profileId,
            this.userDataPath,
            auth.scope,
            { sourceKey: request.sourceKey, slug: record.slug },
            auth.assertCurrent
          )
        })
      })
    )
  }

  delete(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.withAuth(options, (token, apiUrl, auth) =>
      this.publisher.runForSlug(id, auth, async () => {
        auth.assertCanSend()
        await deleteArtifactRequest(apiUrl, token, `/${encodeURIComponent(id)}`, auth)
        await removeArtifactShareRecords(
          auth.profileId,
          this.userDataPath,
          auth.scope,
          { slug: id },
          auth.assertCurrent
        )
      })
    )
  }

  private async withSharingAuth<T>(
    options: ArtifactCloudOptions,
    operation: (token: string, apiUrl: string, auth: ArtifactAuthContext) => Promise<T>
  ): Promise<ArtifactCloudOperation<T>> {
    const assertAllowed = (): void => {
      if (isTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.artifactSharing)) {
        throw new Error('Artifact sharing is turned off by your team.')
      }
      assertArtifactSharingAllowed(this.isSharingEnabled)
    }
    assertAllowed()
    return this.withAuth(options, (token, apiUrl, auth) => {
      assertAllowed()
      return operation(token, apiUrl, auth)
    })
  }

  private async withAuth<T>(
    options: ArtifactCloudOptions,
    operation: (token: string, apiUrl: string, auth: ArtifactAuthContext) => Promise<T>
  ): Promise<ArtifactCloudOperation<T>> {
    const apiUrl = resolveArtifactCloudApiUrl(options.apiUrl)
    const active = ensureActiveOrcaProfile(this.userDataPath)
    prepareArtifactCloudUse(active.profile, this.userDataPath)
    // Outlives the 401 re-run below, so the whole operation gets one rate-limit wait.
    const rateLimitAllowance = createArtifactRateLimitAllowance()
    if (options.authToken?.trim()) {
      if (!allowsArtifactCloudAuthOverride()) {
        throw new Error(
          'Artifact authentication overrides are available only in development builds.'
        )
      }
      const token = options.authToken.trim()
      const auth = explicitTokenAuthContext(
        active,
        apiUrl,
        token,
        this.userDataPath,
        rateLimitAllowance
      )
      const value = await operation(token, apiUrl, auth)
      auth.assertCurrent()
      return {
        status: 'ok',
        value
      }
    }
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      return { status: 'unconfigured', message: config.setupMessage }
    }
    if (
      requiresExplicitCloudServiceUrl(
        config.config,
        options.apiUrl?.trim() || process.env.ORCA_ARTIFACTS_API_URL
      )
    ) {
      return {
        status: 'unconfigured',
        message: 'Configure an explicit artifact service URL before using a custom cloud server.'
      }
    }
    const result = await runWithFreshOrcaCloudSession(
      config.config,
      active,
      this.userDataPath,
      async (session) => {
        const auth = storedSessionAuthContext(active, apiUrl, this.userDataPath, rateLimitAllowance)
        const value = await operation(session.accessToken, apiUrl, auth)
        auth.assertCurrent()
        return value
      }
    )
    return result.status === 'ok'
      ? { status: 'ok', value: result.value }
      : { status: 'reconnect-required' }
  }
}
