import {
  MobileWebCreationAgentDetectionPayloadSchema,
  MobileWebCreationAgentDetectionResultSchema,
  MobileWebCreationAvailabilityPayloadSchema,
  MobileWebCreationAvailabilityResultSchema,
  MobileWebCreationPersistTrustPayloadSchema,
  MobileWebCreationRepoHooksResultSchema,
  MobileWebCreationRepoPayloadSchema,
  MobileWebCreationRepositoriesPayloadSchema,
  MobileWebCreationRepositoriesResultSchema,
  MobileWebCreationRetiredNamesResultSchema,
  MobileWebCreationRuntimeCapabilitiesPayloadSchema,
  MobileWebCreationRuntimeCapabilitiesResultSchema,
  MobileWebCreationSettingsPayloadSchema,
  MobileWebCreationSettingsResultSchema,
  MobileWebCreationSparsePresetSavePayloadSchema,
  MobileWebCreationSparsePresetSaveResultSchema,
  MobileWebCreationSparsePresetsResultSchema,
  MobileWebCreationSshStateResultSchema,
  MobileWebCreationTrustedHooksPayloadSchema,
  MobileWebCreationTrustedHooksResultSchema
} from '../../../src/shared/mobile-web/workspace-creation-read-contract'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import {
  getRepoExecutionHostId,
  getExecutionHostLabel,
  parseExecutionHostId
} from '../../../src/shared/execution-host'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostWorkspaceCreationOperations } from '../worktree/native-host-workspace-creation-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebWorkspaceCreationReadOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  const operations = nativeHostWorkspaceCreationOperations(args.client)
  if (args.operation === 'creationRepositories') {
    MobileWebCreationRepositoriesPayloadSchema.parse(args.payload)
    const repositories = await operations.listRepositories()
    args.authority.synchronizeCreationRepositories(repositories)
    return MobileWebCreationRepositoriesResultSchema.parse({
      repositories: repositories.map((repo) => {
        const id = args.authority.pageRepoId(repo.id)
        const executionHostId = getRepoExecutionHostId(repo)
        return {
          id,
          displayName: repo.displayName,
          path: repo.path,
          ...(repo.badgeColor ? { badgeColor: repo.badgeColor } : {}),
          connectionId: repo.connectionId ? id : null,
          executionHostId: args.authority.pageExecutionHostId(executionHostId),
          executionHostLabel: pageExecutionHostLabel(executionHostId),
          projectId: args.authority.pageProjectId(getProjectIdentityKey(repo)),
          ...(repo.upstream
            ? {
                upstream: {
                  owner: repo.upstream.owner,
                  repo: repo.upstream.repo,
                  ...(repo.upstream.host ? { host: repo.upstream.host } : {})
                }
              }
            : {}),
          ...(repo.kind ? { kind: repo.kind } : {})
        }
      })
    })
  }
  if (args.operation === 'creationSettings') {
    MobileWebCreationSettingsPayloadSchema.parse(args.payload)
    const settings = await operations.readRuntimeSettings()
    return MobileWebCreationSettingsResultSchema.parse({
      defaultTuiAgent: settings.defaultTuiAgent,
      disabledTuiAgents: settings.disabledTuiAgents,
      visibleTaskProviders: Array.isArray(settings.visibleTaskProviders)
        ? settings.visibleTaskProviders.filter(
            (value): value is 'github' | 'gitlab' | 'linear' =>
              value === 'github' || value === 'gitlab' || value === 'linear'
          )
        : undefined
    })
  }
  if (args.operation === 'creationTrustedHooks') {
    MobileWebCreationTrustedHooksPayloadSchema.parse(args.payload)
    return pageTrust(await operations.readTrustedHooks(), args.authority)
  }
  if (
    args.operation === 'creationGitLabAvailability' ||
    args.operation === 'creationLinearAvailability'
  ) {
    MobileWebCreationAvailabilityPayloadSchema.parse(args.payload)
    const available =
      args.operation === 'creationGitLabAvailability'
        ? await operations.isGitLabCliInstalled()
        : await operations.isLinearConnected()
    return MobileWebCreationAvailabilityResultSchema.parse({ available })
  }
  if (args.operation === 'creationRuntimeCapabilities') {
    MobileWebCreationRuntimeCapabilitiesPayloadSchema.parse(args.payload)
    const capabilities = await operations.readRuntimeCapabilities()
    return MobileWebCreationRuntimeCapabilitiesResultSchema.parse({
      ...capabilities,
      idempotentWorktreeCreateSupported: capabilities.worktreeCreateIdempotency !== false
    })
  }
  if (args.operation === 'creationSparsePresets') {
    const payload = MobileWebCreationRepoPayloadSchema.parse(args.payload)
    return MobileWebCreationSparsePresetsResultSchema.parse({
      presets: (await operations.listSparsePresets(args.authority.hostRepoId(payload.repoId))).map(
        (preset) => ({ ...preset, repoId: payload.repoId })
      )
    })
  }
  if (args.operation === 'creationSaveSparsePreset') {
    const payload = MobileWebCreationSparsePresetSavePayloadSchema.parse(args.payload)
    return MobileWebCreationSparsePresetSaveResultSchema.parse({
      preset: {
        ...(await operations.saveSparsePreset(args.authority.hostRepoId(payload.repoId), {
          ...(payload.id ? { id: payload.id } : {}),
          name: payload.name,
          directories: payload.directories
        })),
        repoId: payload.repoId
      }
    })
  }
  return executeRepoCreationRead(args, operations)
}

function pageExecutionHostLabel(
  executionHostId: ReturnType<typeof getRepoExecutionHostId>
): string {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'local' ? getExecutionHostLabel(executionHostId) : 'Host'
}

async function executeRepoCreationRead(
  args: {
    operation: string
    payload: unknown
    authority: MobileWebWorkspaceAuthority
  },
  operations: ReturnType<typeof nativeHostWorkspaceCreationOperations>
): Promise<unknown> {
  if (args.operation === 'creationDetectAgents') {
    const payload = MobileWebCreationAgentDetectionPayloadSchema.parse(args.payload)
    const connectionId = payload.repoId ? args.authority.hostConnectionId(payload.repoId) : null
    return MobileWebCreationAgentDetectionResultSchema.parse({
      agentIds: await operations.detectAgents(connectionId)
    })
  }
  if (args.operation === 'creationPersistTrust') {
    const payload = MobileWebCreationPersistTrustPayloadSchema.parse(args.payload)
    const hostRepoId = args.authority.hostRepoId(payload.repoId)
    const next = await operations.persistSetupTrust({
      trust: hostTrust(payload.trust, args.authority),
      repoId: hostRepoId,
      contentHash: payload.contentHash,
      alwaysTrust: payload.alwaysTrust
    })
    return pageTrust(next, args.authority)
  }
  const payload = MobileWebCreationRepoPayloadSchema.parse(args.payload)
  const hostRepoId = args.authority.hostRepoId(payload.repoId)
  if (args.operation === 'creationRetiredNames') {
    return MobileWebCreationRetiredNamesResultSchema.parse(
      await operations.readRetiredWorktreeNames(hostRepoId)
    )
  }
  if (args.operation === 'creationSshState' || args.operation === 'creationSshConnect') {
    const connectionId = args.authority.hostConnectionId(payload.repoId)
    const state =
      args.operation === 'creationSshConnect'
        ? await operations.connectSsh(connectionId)
        : await operations.readSshState(connectionId)
    return MobileWebCreationSshStateResultSchema.parse({
      targetId: payload.repoId,
      status: state.status,
      error: state.error ? 'SSH connection failed.' : null,
      reconnectAttempt: state.reconnectAttempt,
      supportsFolderDownload: state.supportsFolderDownload,
      remotePlatform: state.remotePlatform
    })
  }
  if (args.operation === 'creationRepoHooks') {
    const hooks = await operations.readRepoHooks(hostRepoId)
    return MobileWebCreationRepoHooksResultSchema.parse({
      ...hooks,
      source: hooks.source ? 'orca.yaml' : null
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function pageTrust(
  trust: PersistedTrustedOrcaHooks,
  authority: MobileWebWorkspaceAuthority
): unknown {
  const pageEntries: PersistedTrustedOrcaHooks = {}
  for (const [hostRepoId, entry] of Object.entries(trust)) {
    try {
      pageEntries[authority.pageRepoId(hostRepoId)] = entry
    } catch {
      // Why: stale trust for a removed repo is irrelevant to the current page authority.
    }
  }
  return MobileWebCreationTrustedHooksResultSchema.parse(pageEntries)
}

function hostTrust(
  trust: PersistedTrustedOrcaHooks,
  authority: MobileWebWorkspaceAuthority
): PersistedTrustedOrcaHooks {
  return Object.fromEntries(
    Object.entries(trust).map(([pageRepoId, entry]) => [authority.hostRepoId(pageRepoId), entry])
  )
}
