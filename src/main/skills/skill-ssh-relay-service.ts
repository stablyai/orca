import {
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from '../../shared/skill-install-capability'
import {
  ManagedSkillInstallListSchema,
  SkillInstallPreviewSchema,
  SkillInstallResultSchema,
  type ManagedSkillInstall,
  type SkillInstallPreview,
  type SkillInstallPreviewRequest,
  type SkillInstallRequest,
  type SkillInstallResult,
  type SkillRemoveRequest
} from '../../shared/skill-install-contract'
import {
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD,
  SKILL_SSH_RELAY_INSTALL_METHOD,
  SKILL_SSH_RELAY_LIST_METHOD,
  SKILL_SSH_RELAY_PREVIEW_METHOD,
  SKILL_SSH_RELAY_REMOVE_METHOD,
  type SkillSshWorkspaceAuthority
} from '../../shared/skill-ssh-relay-contract'
import { recordSkillCapabilityAbsence } from './skill-operation-observability'
import { retrySkillTransferRpc } from './skill-transfer-rpc-retry'
import { transferSkillPackageToSshHost } from './skill-ssh-package-transfer'
import {
  SKILL_SSH_REQUEST_TIMEOUT_MS,
  requireSkillSshRelayClient,
  retryableSkillSshTransportError,
  shouldUseSkillSshClientTransfer,
  skillSshRelayCapabilities
} from './skill-ssh-relay-client'
import type { SkillSshProviderSource } from './skill-ssh-relay-client'

const NON_RETRYABLE_SKILL_TRANSFER_ERRORS = new Set([
  'skill-install-ssh-update-required',
  'skill-install-ssh-download-unavailable'
])

export async function supportsSkillManagementOnSsh(
  provider: SkillSshProviderSource
): Promise<boolean> {
  return (await skillSshRelayCapabilities(requireSkillSshRelayClient(provider))).includes(
    SKILL_MANAGEMENT_CAPABILITY
  )
}

export async function installSkillOnSshHost(input: {
  provider: SkillSshProviderSource
  userDataPath: string
  request: SkillInstallRequest
  workspace?: SkillSshWorkspaceAuthority
  requireHttps: boolean
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<SkillInstallResult> {
  const request = input.request
  try {
    return SkillInstallResultSchema.parse(
      await retrySkillTransferRpc({
        signal: input.signal,
        retryable: (error) =>
          (error as Error)?.message !== 'skill-install-ssh-update-required' &&
          retryableSkillSshTransportError(error),
        call: async () => {
          const client = requireSkillSshRelayClient(input.provider)
          const supported = await skillSshRelayCapabilities(client)
          if (
            request.providers !== undefined &&
            !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)
          ) {
            throw new Error('skill-install-ssh-update-required')
          }
          if (!supported.includes(SKILL_INSTALL_CAPABILITY)) {
            recordSkillCapabilityAbsence({
              capability: SKILL_INSTALL_CAPABILITY,
              destination: 'global-ssh'
            })
            throw new Error('skill-install-ssh-update-required')
          }
          return client(
            SKILL_SSH_RELAY_INSTALL_METHOD,
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
  return retrySkillTransferRpc({
    signal: input.signal,
    retryable: (error) =>
      !NON_RETRYABLE_SKILL_TRANSFER_ERRORS.has((error as Error)?.message) &&
      retryableSkillSshTransportError(error),
    call: async () => {
      const client = requireSkillSshRelayClient(input.provider)
      const supported = await skillSshRelayCapabilities(client)
      if (
        !supported.includes(SKILL_INSTALL_CAPABILITY) ||
        (request.providers !== undefined && !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY))
      ) {
        throw new Error('skill-install-ssh-update-required')
      }
      if (!supported.includes(SKILL_UPLOAD_CAPABILITY)) {
        recordSkillCapabilityAbsence({
          capability: SKILL_UPLOAD_CAPABILITY,
          destination: 'global-ssh'
        })
        throw new Error('skill-install-ssh-download-unavailable')
      }
      const uploadId = await transferSkillPackageToSshHost(client, input)
      try {
        return SkillInstallResultSchema.parse(
          await client(
            SKILL_SSH_RELAY_INSTALL_METHOD,
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
}

export async function previewSkillInstallOnSshHost(input: {
  provider: SkillSshProviderSource
  request: SkillInstallPreviewRequest
  workspace?: SkillSshWorkspaceAuthority
}): Promise<SkillInstallPreview> {
  const client = requireSkillSshRelayClient(input.provider)
  if (!(await skillSshRelayCapabilities(client)).includes(SKILL_MANAGEMENT_CAPABILITY)) {
    throw new Error('skill-install-ssh-update-required')
  }
  return SkillInstallPreviewSchema.parse(
    await client(
      SKILL_SSH_RELAY_PREVIEW_METHOD,
      { request: input.request, workspace: input.workspace },
      { timeoutMs: 30_000 }
    )
  )
}

export async function removeSkillInstallOnSshHost(input: {
  provider: SkillSshProviderSource
  request: SkillRemoveRequest
  workspace?: SkillSshWorkspaceAuthority
}): Promise<SkillInstallResult> {
  const client = requireSkillSshRelayClient(input.provider)
  if (!(await skillSshRelayCapabilities(client)).includes(SKILL_MANAGEMENT_CAPABILITY)) {
    throw new Error('skill-install-ssh-update-required')
  }
  return SkillInstallResultSchema.parse(
    await client(
      SKILL_SSH_RELAY_REMOVE_METHOD,
      { request: input.request, workspace: input.workspace },
      { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS }
    )
  )
}

export async function listSkillInstallsOnSshHost(input: {
  provider: SkillSshProviderSource
  connectionId: string
  workspaces: SkillSshWorkspaceAuthority[]
}): Promise<ManagedSkillInstall[]> {
  const client = requireSkillSshRelayClient(input.provider)
  if (!(await skillSshRelayCapabilities(client)).includes(SKILL_MANAGEMENT_CAPABILITY)) {
    throw new Error('skill-install-ssh-update-required')
  }
  return ManagedSkillInstallListSchema.parse(
    await client(
      SKILL_SSH_RELAY_LIST_METHOD,
      { workspaces: input.workspaces },
      { timeoutMs: 30_000 }
    )
  ).map((install) => ({
    ...install,
    destination:
      install.destination.scope === 'global'
        ? {
            scope: 'global' as const,
            executionTarget: { kind: 'ssh' as const, connectionId: input.connectionId }
          }
        : install.destination
  }))
}
