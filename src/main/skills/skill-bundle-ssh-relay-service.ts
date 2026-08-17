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
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from '../../shared/skill-install-capability'
import {
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD,
  SKILL_SSH_RELAY_GET_INSTALL_PROGRESS_METHOD,
  SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
  SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
  type SkillSshWorkspaceAuthority
} from '../../shared/skill-ssh-relay-contract'
import {
  SKILL_SSH_REQUEST_TIMEOUT_MS,
  requireSkillSshRelayClient,
  retryableSkillSshTransportError,
  shouldUseSkillSshClientTransfer,
  skillSshRelayCapabilities
} from './skill-ssh-relay-client'
import type { SkillSshProviderSource } from './skill-ssh-relay-client'
import { transferSkillPackageToSshHost } from './skill-ssh-package-transfer'
import { retrySkillTransferRpc } from './skill-transfer-rpc-retry'
import { startSkillInstallProgressPolling } from './skill-install-progress-polling'
import { recordSkillCapabilityAbsence } from './skill-operation-observability'

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
  const client = requireSkillSshRelayClient(input.provider)
  const supported = await skillSshRelayCapabilities(client)
  const request = input.request
  if (request.providers !== undefined && !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)) {
    throw new Error('skill-bundle-ssh-update-required')
  }
  if (!supported.includes(SKILL_BUNDLE_INSTALL_CAPABILITY)) {
    recordSkillCapabilityAbsence({
      capability: SKILL_BUNDLE_INSTALL_CAPABILITY,
      destination: 'global-ssh'
    })
    throw new Error('skill-bundle-ssh-update-required')
  }
  const stopProgress =
    input.onProgress && supported.includes(SKILL_INSTALL_PROGRESS_CAPABILITY)
      ? startSkillInstallProgressPolling({
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
      : null
  try {
    try {
      return SkillBundleInstallResultSchema.parse(
        await retrySkillTransferRpc({
          signal: input.signal,
          retryable: retryableSkillSshTransportError,
          call: () =>
            client(
              SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
              { request: request, workspace: input.workspace },
              { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
            )
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
    if (!supported.includes(SKILL_UPLOAD_CAPABILITY)) {
      recordSkillCapabilityAbsence({
        capability: SKILL_UPLOAD_CAPABILITY,
        destination: 'global-ssh'
      })
      throw new Error('skill-bundle-ssh-download-unavailable')
    }
    return await retrySkillTransferRpc({
      signal: input.signal,
      retryable: retryableSkillSshTransportError,
      call: async () => {
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
    stopProgress?.()
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
        (error as Error)?.message !== 'skill-bundle-ssh-update-required' &&
        retryableSkillSshTransportError(error),
      call: async () => {
        const provider = typeof input.provider === 'function' ? input.provider() : input.provider
        const client = requireSkillSshRelayClient(provider)
        if (!(await skillSshRelayCapabilities(client)).includes(SKILL_BUNDLE_PREVIEW_CAPABILITY)) {
          recordSkillCapabilityAbsence({
            capability: SKILL_BUNDLE_PREVIEW_CAPABILITY,
            destination: 'global-ssh'
          })
          throw new Error('skill-bundle-ssh-update-required')
        }
        return client(
          SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
          { request: input.request, workspace: input.workspace },
          { timeoutMs: 30_000 }
        )
      }
    })
  )
}
