import { ZodError } from 'zod'
import {
  SkillBundleInstallProgressSchema,
  SkillBundleInstallPreviewSchema,
  SkillBundleInstallResultSchema,
  type SkillBundleInstallProgress,
  type SkillBundleInstallPreview,
  type SkillBundleInstallPreviewRequest,
  type SkillBundleInstallRequest,
  type SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_BUNDLE_PREVIEW_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from '../../shared/skill-install-capability'
import {
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD,
  SKILL_SSH_RELAY_GET_INSTALL_PROGRESS_METHOD,
  SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
  SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
  SKILL_SSH_RELAY_PREVIEW_METHOD,
  type SkillSshWorkspaceAuthority
} from '../../shared/skill-ssh-relay-contract'
import {
  SkillInstallPreviewSchema,
  type SkillInstallPreview
} from '../../shared/skill-install-contract'
import {
  SKILL_SSH_REQUEST_TIMEOUT_MS,
  requireSkillSshRelayClient,
  retryableSkillSshTransportError,
  shouldUseSkillSshClientTransfer,
  skillSshRelayCapabilities
} from './skill-ssh-relay-client'
import type { SkillSshProviderSource, SkillSshRelayClient } from './skill-ssh-relay-client'
import { transferSkillPackageToSshHost } from './skill-ssh-package-transfer'
import { retrySkillTransferRpc } from './skill-transfer-rpc-retry'
import { startSkillInstallProgressPolling } from './skill-install-progress-polling'
import { recordSkillCapabilityAbsence } from './skill-operation-observability'

const NON_RETRYABLE_BUNDLE_TRANSFER_ERRORS = new Set([
  'skill-bundle-ssh-update-required',
  'skill-bundle-ssh-download-unavailable'
])
const LEGACY_BUNDLE_PREVIEW_CONCURRENCY = 8

async function previewBundleWithLegacyRpc(
  client: SkillSshRelayClient,
  input: {
    request: SkillBundleInstallPreviewRequest
    workspace?: SkillSshWorkspaceAuthority
  }
): Promise<SkillBundleInstallPreview> {
  const previews: SkillInstallPreview[] = []
  for (
    let offset = 0;
    offset < input.request.selectedSkills.length;
    offset += LEGACY_BUNDLE_PREVIEW_CONCURRENCY
  ) {
    const batch = input.request.selectedSkills.slice(
      offset,
      offset + LEGACY_BUNDLE_PREVIEW_CONCURRENCY
    )
    const batchAbort = new AbortController()
    const failures: { reason: unknown }[] = []
    const results = await Promise.allSettled(
      batch.map(async (skill) => {
        try {
          return SkillInstallPreviewSchema.parse(
            await client(
              SKILL_SSH_RELAY_PREVIEW_METHOD,
              {
                request: {
                  package: {
                    packageId: input.request.package.packageId,
                    versionId: input.request.package.versionId,
                    packageDigest: skill.digest,
                    archiveSha256: input.request.package.archiveSha256,
                    compressedBytes: input.request.package.compressedBytes
                  },
                  name: skill.name,
                  destination: input.request.destination
                },
                workspace: input.workspace
              },
              { timeoutMs: 30_000, signal: batchAbort.signal }
            )
          )
        } catch (error) {
          failures.push({ reason: error })
          if (failures.length === 1) {
            batchAbort.abort()
          }
          throw error
        }
      })
    )
    const [firstFailure] = failures
    if (firstFailure) {
      throw firstFailure.reason
    }
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        continue
      }
      previews.push(result.value)
    }
  }
  return SkillBundleInstallPreviewSchema.parse({
    packageId: input.request.package.packageId,
    versionId: input.request.package.versionId,
    bundleDigest: input.request.package.bundleDigest,
    destinationIdentity: previews[0]?.destinationIdentity ?? '',
    skills: input.request.selectedSkills.map((skill, index) => ({
      ...skill,
      currentState: previews[index]?.currentState
    }))
  })
}

export async function installSkillBundleOnSshHost(input: {
  provider: SkillSshProviderSource
  userDataPath: string
  request: SkillBundleInstallRequest
  workspace?: SkillSshWorkspaceAuthority
  requireHttps: boolean
  signal?: AbortSignal
  onProgress?: (progress: SkillBundleInstallProgress) => void
  fetcher?: typeof fetch
}): Promise<SkillBundleInstallResult> {
  const request = input.request
  let stopProgress = (): void => undefined
  function restartProgress(client: SkillSshRelayClient, supported: string[]): void {
    stopProgress()
    stopProgress = (): void => undefined
    if (input.onProgress && supported.includes(SKILL_INSTALL_PROGRESS_CAPABILITY)) {
      stopProgress = startSkillInstallProgressPolling({
        read: async () => {
          const value = await client(
            SKILL_SSH_RELAY_GET_INSTALL_PROGRESS_METHOD,
            { operationId: request.operationId },
            { timeoutMs: 2_000, signal: input.signal }
          )
          if (value === null) {
            return null
          }
          const parsed = SkillBundleInstallProgressSchema.safeParse(value)
          return parsed.success ? parsed.data : null
        },
        onProgress: input.onProgress
      })
    }
  }
  try {
    try {
      return SkillBundleInstallResultSchema.parse(
        await retrySkillTransferRpc({
          signal: input.signal,
          retryable: (error) =>
            (error as Error)?.message !== 'skill-bundle-ssh-update-required' &&
            retryableSkillSshTransportError(error),
          call: async () => {
            const client = requireSkillSshRelayClient(input.provider)
            const supported = await skillSshRelayCapabilities(client)
            if (
              request.providers !== undefined &&
              !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)
            ) {
              throw new Error('skill-bundle-ssh-update-required')
            }
            if (!supported.includes(SKILL_BUNDLE_INSTALL_CAPABILITY)) {
              recordSkillCapabilityAbsence({
                capability: SKILL_BUNDLE_INSTALL_CAPABILITY,
                destination: 'global-ssh'
              })
              throw new Error('skill-bundle-ssh-update-required')
            }
            restartProgress(client, supported)
            return client(
              SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
              { request, workspace: input.workspace },
              { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
            )
          }
        })
      )
    } catch (error) {
      if (
        request.ingress.kind !== 'download-grant' ||
        !shouldUseSkillSshClientTransfer(error, input.requireHttps)
      ) {
        throw error
      }
    }
    return await retrySkillTransferRpc({
      signal: input.signal,
      retryable: (error) =>
        !NON_RETRYABLE_BUNDLE_TRANSFER_ERRORS.has((error as Error)?.message) &&
        retryableSkillSshTransportError(error),
      call: async () => {
        const client = requireSkillSshRelayClient(input.provider)
        const supported = await skillSshRelayCapabilities(client)
        if (
          !supported.includes(SKILL_BUNDLE_INSTALL_CAPABILITY) ||
          (request.providers !== undefined &&
            !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY))
        ) {
          throw new Error('skill-bundle-ssh-update-required')
        }
        if (!supported.includes(SKILL_UPLOAD_CAPABILITY)) {
          recordSkillCapabilityAbsence({
            capability: SKILL_UPLOAD_CAPABILITY,
            destination: 'global-ssh'
          })
          throw new Error('skill-bundle-ssh-download-unavailable')
        }
        restartProgress(client, supported)
        const uploadId = await transferSkillPackageToSshHost(client, input)
        try {
          return SkillBundleInstallResultSchema.parse(
            await client(
              SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
              {
                request: {
                  ...request,
                  ingress: { kind: 'staged-upload', uploadId }
                },
                workspace: input.workspace
              },
              { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
            )
          )
        } finally {
          await client(SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD, { uploadId }).catch(() => undefined)
        }
      }
    })
  } finally {
    stopProgress()
  }
}

export async function previewSkillBundleInstallOnSshHost(input: {
  provider: SkillSshProviderSource
  request: SkillBundleInstallPreviewRequest
  workspace?: SkillSshWorkspaceAuthority
}): Promise<SkillBundleInstallPreview> {
  return SkillBundleInstallPreviewSchema.parse(
    await retrySkillTransferRpc({
      retryable: (error) =>
        !(error instanceof ZodError) &&
        (error as Error)?.message !== 'skill-bundle-ssh-update-required' &&
        retryableSkillSshTransportError(error),
      call: async () => {
        const client = requireSkillSshRelayClient(input.provider)
        const supported = await skillSshRelayCapabilities(client)
        if (supported.includes(SKILL_BUNDLE_PREVIEW_CAPABILITY)) {
          return client(
            SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
            { request: input.request, workspace: input.workspace },
            { timeoutMs: 30_000 }
          )
        }
        recordSkillCapabilityAbsence({
          capability: SKILL_BUNDLE_PREVIEW_CAPABILITY,
          destination: 'global-ssh'
        })
        if (!supported.includes(SKILL_MANAGEMENT_CAPABILITY)) {
          throw new Error('skill-bundle-ssh-update-required')
        }
        return previewBundleWithLegacyRpc(client, input)
      }
    })
  )
}
