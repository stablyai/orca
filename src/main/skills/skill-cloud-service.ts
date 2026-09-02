import { createHash, randomUUID } from 'node:crypto'
import type {
  SkillCloudDownloadGrant,
  SkillCloudInstallTarget,
  SkillCloudOwnedShare,
  SkillCloudOperation,
  SkillCloudOptions,
  SkillCloudPackageDetails,
  SkillCloudPublishRequest,
  SkillCloudPublishResult,
  SkillCloudShare,
  SkillCloudVersion
} from '../../shared/skill-cloud-contract'
import { resolveArtifactCloudApiUrl } from '../artifacts/artifact-cloud-config'
import { runSkillCloudOperation } from './skill-cloud-auth'
import { uploadSkillPackageToSignedPolicy } from './skill-cloud-direct-upload'
import { skillCloudRequest } from './skill-cloud-request'
import { startSkillPhaseOperation } from './skill-operation-observability'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function publishUploadIdempotencyKey(request: SkillCloudPublishRequest): string {
  return (
    request.idempotencyKey ??
    createHash('sha256').update(`${request.packageId}\0${request.archiveSha256}`).digest('hex')
  )
}

function id(value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new Error('skill-cloud-id-invalid')
  }
  return encodeURIComponent(value)
}

export class SkillCloudService {
  constructor(private readonly userDataPath: string) {}

  async publish(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudPublishResult>> {
    const version = await this.publishVersion(request)
    if (version.status !== 'ok') {
      return version
    }
    const share = await this.createShare(version.value.packageId, request)
    return share.status === 'ok'
      ? { status: 'ok', value: { version: version.value, share: share.value } }
      : share
  }

  publishVersion(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudVersion>> {
    return this.withAuth(request, async (token, apiUrl) => {
      let upload: {
        upload: {
          id: string
          policy: { url: string; fields: Record<string, string>; expiresAt: string }
        }
      }
      try {
        upload = await skillCloudRequest<typeof upload>({
          apiUrl,
          authToken: token,
          path: '/v1/skill-packages/uploads',
          method: 'POST',
          body: {
            expectedArchiveSha256: request.archiveSha256,
            expectedCompressedBytes: request.compressedBytes
          },
          idempotencyKey: publishUploadIdempotencyKey(request),
          signal: request.signal
        })
      } catch (error) {
        const existing = await skillCloudRequest<{ package: SkillCloudPackageDetails }>({
          apiUrl,
          authToken: token,
          path: `/v1/skill-packages/${id(request.packageId)}`,
          signal: request.signal
        }).catch(() => null)
        const published = existing?.package.versions.find(
          (version) =>
            version.archiveSha256 === request.archiveSha256 &&
            version.compressedBytes === request.compressedBytes
        )
        if (published) {
          return published
        }
        throw error
      }
      const uploadOperation = startSkillPhaseOperation({
        phase: 'upload',
        compressedBytes: request.compressedBytes
      })
      try {
        await uploadSkillPackageToSignedPolicy({
          policy: upload.upload.policy,
          archivePath: request.archivePath,
          expectedBytes: request.compressedBytes,
          signal: request.signal,
          onProgress: (bytesSent) =>
            request.onProgress?.({
              phase: 'uploading',
              bytesSent,
              totalBytes: request.compressedBytes
            })
        })
        uploadOperation.complete({
          status: 'complete',
          compressedBytes: request.compressedBytes
        })
      } catch (error) {
        uploadOperation.fail(error)
        throw error
      }
      request.onProgress?.({
        phase: 'finalizing',
        bytesSent: request.compressedBytes,
        totalBytes: request.compressedBytes
      })
      const finalizationOperation = startSkillPhaseOperation({
        phase: 'finalization',
        compressedBytes: request.compressedBytes
      })
      let finalized: { version: SkillCloudVersion }
      try {
        finalized = await skillCloudRequest<{ version: SkillCloudVersion }>({
          apiUrl,
          authToken: token,
          path: `/v1/skill-packages/uploads/${id(upload.upload.id)}/finalize`,
          method: 'POST',
          body: { releaseNotes: request.releaseNotes },
          idempotencyKey: upload.upload.id,
          signal: request.signal
        })
        if (finalized.version.packageId !== request.packageId) {
          throw new Error('skill-cloud-published-package-mismatch')
        }
        finalizationOperation.complete({ status: 'complete' })
      } catch (error) {
        finalizationOperation.fail(error)
        throw error
      }
      return finalized.version
    })
  }

  createShare(
    packageId: string,
    request: SkillCloudOptions & {
      pinnedVersionId?: string
      idempotencyKey?: string
      signal?: AbortSignal
    }
  ): Promise<SkillCloudOperation<SkillCloudShare>> {
    return this.withAuth(request, async (token, apiUrl) => {
      const shared = await skillCloudRequest<{ share: SkillCloudShare }>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/${id(packageId)}/shares`,
        method: 'POST',
        body: {
          pinnedVersionId: request.pinnedVersionId
        },
        idempotencyKey: request.idempotencyKey ?? randomUUID(),
        signal: request.signal
      })
      return shared.share
    })
  }

  resolveShare(
    shareId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<{ id: string; version: SkillCloudVersion }>> {
    return this.withoutAuth(options, async (apiUrl) => {
      const result = await skillCloudRequest<{
        share: { id: string; version: SkillCloudVersion }
      }>({ apiUrl, path: `/v1/skill-shares/${id(shareId)}` })
      return result.share
    })
  }

  createDownloadGrant(
    shareId: string,
    options: SkillCloudOptions & { versionId?: string; installTarget?: SkillCloudInstallTarget }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.withoutAuth(options, (apiUrl) =>
      skillCloudRequest<SkillCloudDownloadGrant>({
        apiUrl,
        path: `/v1/skill-shares/${id(shareId)}/download-grants`,
        method: 'POST',
        body: {
          ...(options.versionId ? { versionId: options.versionId } : {}),
          ...(options.installTarget ? { installTarget: options.installTarget } : {})
        }
      })
    )
  }

  createPackageVersionDownloadGrant(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions & { installTarget?: SkillCloudInstallTarget }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.withAuth(options, (token, apiUrl) =>
      skillCloudRequest<SkillCloudDownloadGrant>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/${id(packageId)}/versions/${id(versionId)}/download-grants`,
        method: 'POST',
        body: options.installTarget ? { installTarget: options.installTarget } : {}
      })
    )
  }

  getPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<SkillCloudPackageDetails>> {
    return this.withAuth(options, async (token, apiUrl) => {
      const result = await skillCloudRequest<{ package: SkillCloudPackageDetails }>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/${id(packageId)}`
      })
      return result.package
    })
  }

  listOwnedShares(
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<SkillCloudOwnedShare[]>> {
    return this.withAuth(options, async (token, apiUrl) => {
      const result = await skillCloudRequest<{ shares: SkillCloudOwnedShare[] }>({
        apiUrl,
        authToken: token,
        path: '/v1/skill-shares'
      })
      return result.shares
    })
  }

  revokeShare(shareId: string, options: SkillCloudOptions): Promise<SkillCloudOperation<void>> {
    return this.withAuth(options, (token, apiUrl) =>
      skillCloudRequest<void>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-shares/${id(shareId)}`,
        method: 'DELETE'
      })
    )
  }

  deleteVersion(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.withAuth(options, (token, apiUrl) =>
      skillCloudRequest<void>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/${id(packageId)}/versions/${id(versionId)}`,
        method: 'DELETE'
      })
    )
  }

  deletePackage(packageId: string, options: SkillCloudOptions): Promise<SkillCloudOperation<void>> {
    return this.withAuth(options, (token, apiUrl) =>
      skillCloudRequest<void>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/${id(packageId)}`,
        method: 'DELETE'
      })
    )
  }

  private withAuth<T>(
    options: SkillCloudOptions,
    operation: (token: string, apiUrl: string) => Promise<T>
  ): Promise<SkillCloudOperation<T>> {
    return runSkillCloudOperation({
      userDataPath: this.userDataPath,
      options,
      operation
    })
  }

  private async withoutAuth<T>(
    options: SkillCloudOptions,
    operation: (apiUrl: string) => Promise<T>
  ): Promise<SkillCloudOperation<T>> {
    const value = await operation(resolveArtifactCloudApiUrl(options.apiUrl))
    return { status: 'ok', value }
  }
}
