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
import type { IPtyProvider } from '../providers/pty-provider-contract'
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

export async function supportsSkillManagementOnSsh(provider: IPtyProvider): Promise<boolean> {
  return (await skillSshRelayCapabilities(requireSkillSshRelayClient(provider))).includes(
    SKILL_MANAGEMENT_CAPABILITY
  )
}

export async function installSkillOnSshHost(input: {
  provider: IPtyProvider
  userDataPath: string
  request: SkillInstallRequest
  workspace?: SkillSshWorkspaceAuthority
  requireHttps: boolean
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<SkillInstallResult> {
  const client = requireSkillSshRelayClient(input.provider)
  const supported = await skillSshRelayCapabilities(client)
  const request = input.request
  if (request.providers !== undefined && !supported.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)) {
    throw new Error('skill-install-ssh-update-required')
  }
  if (!supported.includes(SKILL_INSTALL_CAPABILITY)) {
    recordSkillCapabilityAbsence({
      capability: SKILL_INSTALL_CAPABILITY,
      destination: 'global-ssh'
    })
    throw new Error('skill-install-ssh-update-required')
  }
  try {
    return SkillInstallResultSchema.parse(
      await retrySkillTransferRpc({
        signal: input.signal,
        retryable: retryableSkillSshTransportError,
        call: () =>
          client(
            SKILL_SSH_RELAY_INSTALL_METHOD,
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
    throw new Error('skill-install-ssh-download-unavailable')
  }
  return retrySkillTransferRpc({
    signal: input.signal,
    retryable: retryableSkillSshTransportError,
    call: async () => {
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
  provider: IPtyProvider
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
  provider: IPtyProvider
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
  provider: IPtyProvider
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
