import type { MobileWebBridgeOperationName } from '../../shared/mobile-web/bridge-operation-registry'
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
  MobileWebCreationTrustedHooksResultSchema,
  type MobileWebCreationAgentDetectionPayload,
  type MobileWebCreationPersistTrustPayload,
  type MobileWebCreationRepoHooksResult,
  type MobileWebCreationRepoPayload,
  type MobileWebCreationRepositoriesResult,
  type MobileWebCreationRetiredNamesResult,
  type MobileWebCreationRuntimeCapabilitiesResult,
  type MobileWebCreationSettingsResult,
  type MobileWebCreationSparsePresetSavePayload,
  type MobileWebCreationSshStateResult,
  type MobileWebCreationTrustedHooksResult
} from '../../shared/mobile-web/workspace-creation-read-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebWorkspaceCreationRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  repositories(): Promise<MobileWebCreationRepositoriesResult> {
    return this.emptyRequest(
      'creationRepositories',
      MobileWebCreationRepositoriesPayloadSchema,
      MobileWebCreationRepositoriesResultSchema
    )
  }

  retiredNames(
    payload: MobileWebCreationRepoPayload
  ): Promise<MobileWebCreationRetiredNamesResult> {
    return this.repoRequest(
      'creationRetiredNames',
      payload,
      MobileWebCreationRetiredNamesResultSchema
    )
  }

  settings(): Promise<MobileWebCreationSettingsResult> {
    return this.emptyRequest(
      'creationSettings',
      MobileWebCreationSettingsPayloadSchema,
      MobileWebCreationSettingsResultSchema
    )
  }

  trustedHooks(): Promise<MobileWebCreationTrustedHooksResult> {
    return this.emptyRequest(
      'creationTrustedHooks',
      MobileWebCreationTrustedHooksPayloadSchema,
      MobileWebCreationTrustedHooksResultSchema
    )
  }

  gitLabAvailable(): Promise<boolean> {
    return this.availability('creationGitLabAvailability')
  }

  linearAvailable(): Promise<boolean> {
    return this.availability('creationLinearAvailability')
  }

  sshState(payload: MobileWebCreationRepoPayload): Promise<MobileWebCreationSshStateResult> {
    return this.repoRequest<MobileWebCreationSshStateResult>(
      'creationSshState',
      payload,
      MobileWebCreationSshStateResultSchema
    ).then((result) => matchingRepoTarget(payload, result))
  }

  sshConnect(payload: MobileWebCreationRepoPayload): Promise<MobileWebCreationSshStateResult> {
    return this.repoRequest<MobileWebCreationSshStateResult>(
      'creationSshConnect',
      payload,
      MobileWebCreationSshStateResultSchema
    ).then((result) => matchingRepoTarget(payload, result))
  }

  detectAgents(payload: MobileWebCreationAgentDetectionPayload): Promise<string[]> {
    return this.requests
      .request(
        'workspace',
        'creationDetectAgents',
        payload,
        MobileWebCreationAgentDetectionPayloadSchema,
        MobileWebCreationAgentDetectionResultSchema
      )
      .then((result) => result.agentIds)
  }

  repoHooks(payload: MobileWebCreationRepoPayload): Promise<MobileWebCreationRepoHooksResult> {
    return this.repoRequest('creationRepoHooks', payload, MobileWebCreationRepoHooksResultSchema)
  }

  runtimeCapabilities(): Promise<MobileWebCreationRuntimeCapabilitiesResult> {
    return this.emptyRequest(
      'creationRuntimeCapabilities',
      MobileWebCreationRuntimeCapabilitiesPayloadSchema,
      MobileWebCreationRuntimeCapabilitiesResultSchema
    )
  }

  sparsePresets(payload: MobileWebCreationRepoPayload) {
    return this.requests
      .request(
        'workspace',
        'creationSparsePresets',
        payload,
        MobileWebCreationRepoPayloadSchema,
        MobileWebCreationSparsePresetsResultSchema
      )
      .then((result) => {
        if (result.presets.some((preset) => preset.repoId !== payload.repoId)) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result.presets
      })
  }

  saveSparsePreset(payload: MobileWebCreationSparsePresetSavePayload) {
    return this.requests
      .request(
        'workspace',
        'creationSaveSparsePreset',
        payload,
        MobileWebCreationSparsePresetSavePayloadSchema,
        MobileWebCreationSparsePresetSaveResultSchema
      )
      .then((result) => {
        const preset = result.preset
        if (
          preset.repoId !== payload.repoId ||
          (payload.id !== undefined && preset.id !== payload.id) ||
          preset.name !== payload.name ||
          !sameStrings(preset.directories, payload.directories)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return preset
      })
  }

  persistTrust(
    payload: MobileWebCreationPersistTrustPayload
  ): Promise<MobileWebCreationTrustedHooksResult> {
    return this.requests.request(
      'workspace',
      'creationPersistTrust',
      payload,
      MobileWebCreationPersistTrustPayloadSchema,
      MobileWebCreationTrustedHooksResultSchema
    )
  }

  private availability(operation: MobileWebBridgeOperationName<'workspace'>): Promise<boolean> {
    return this.emptyRequest<{ available: boolean }>(
      operation,
      MobileWebCreationAvailabilityPayloadSchema,
      MobileWebCreationAvailabilityResultSchema
    ).then((result) => result.available)
  }

  private repoRequest<TResult>(
    operation: MobileWebBridgeOperationName<'workspace'>,
    payload: MobileWebCreationRepoPayload,
    resultSchema: Parameters<MobileWebOneShotRequestClient['request']>[4]
  ): Promise<TResult> {
    return this.requests.request(
      'workspace',
      operation,
      payload,
      MobileWebCreationRepoPayloadSchema,
      resultSchema
    ) as Promise<TResult>
  }

  private emptyRequest<TResult>(
    operation: MobileWebBridgeOperationName<'workspace'>,
    payloadSchema: Parameters<MobileWebOneShotRequestClient['request']>[3],
    resultSchema: Parameters<MobileWebOneShotRequestClient['request']>[4]
  ): Promise<TResult> {
    return this.requests.request(
      'workspace',
      operation,
      {},
      payloadSchema,
      resultSchema
    ) as Promise<TResult>
  }
}

function matchingRepoTarget<TResult extends { targetId: string }>(
  payload: MobileWebCreationRepoPayload,
  result: TResult
): TResult {
  if (result.targetId !== payload.repoId) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return result
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
