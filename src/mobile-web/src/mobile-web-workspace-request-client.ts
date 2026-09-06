import {
  MobileWebWorkspaceActivationPayloadSchema,
  MobileWebWorkspaceActivationResultSchema,
  MobileWebWorkspaceRemovePayloadSchema,
  MobileWebWorkspaceRemoveResultSchema,
  MobileWebWorkspaceRepositoriesPayloadSchema,
  MobileWebWorkspaceRepositoriesResultSchema,
  MobileWebWorkspaceSettingsSnapshotPayloadSchema,
  MobileWebWorkspaceSettingsSnapshotResultSchema,
  MobileWebWorkspaceSettingsUpdatePayloadSchema,
  MobileWebWorkspaceSettingsUpdateResultSchema,
  MobileWebWorkspaceSnapshotPayloadSchema,
  MobileWebWorkspaceSnapshotResultSchema,
  MobileWebWorkspaceUpdatePayloadSchema,
  MobileWebWorkspaceUpdateResultSchema,
  type MobileWebWorkspaceActivationPayload,
  type MobileWebWorkspaceActivationResult,
  type MobileWebWorkspaceRemovePayload,
  type MobileWebWorkspaceRemoveResult,
  type MobileWebWorkspaceRepositoriesResult,
  type MobileWebWorkspaceSnapshotPayload,
  type MobileWebWorkspaceSnapshotResult,
  type MobileWebWorkspaceUpdatePayload,
  type MobileWebWorkspaceUpdateResult,
  type MobileWebWorkspaceViewSettings
} from '../../shared/mobile-web/bridge-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebWorkspaceRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  snapshot(payload: MobileWebWorkspaceSnapshotPayload): Promise<MobileWebWorkspaceSnapshotResult> {
    return this.requests
      .request(
        'workspace',
        'snapshot',
        payload,
        MobileWebWorkspaceSnapshotPayloadSchema,
        MobileWebWorkspaceSnapshotResultSchema
      )
      .then((result) => {
        if (result.workspaces.length > payload.limit) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  activate(
    payload: MobileWebWorkspaceActivationPayload
  ): Promise<MobileWebWorkspaceActivationResult> {
    return this.requests
      .request(
        'workspace',
        'activate',
        payload,
        MobileWebWorkspaceActivationPayloadSchema,
        MobileWebWorkspaceActivationResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  repositories(): Promise<MobileWebWorkspaceRepositoriesResult> {
    return this.requests.request(
      'workspace',
      'repositories',
      {},
      MobileWebWorkspaceRepositoriesPayloadSchema,
      MobileWebWorkspaceRepositoriesResultSchema
    )
  }

  update(payload: MobileWebWorkspaceUpdatePayload): Promise<MobileWebWorkspaceUpdateResult> {
    return this.requests
      .request(
        'workspace',
        'update',
        payload,
        MobileWebWorkspaceUpdatePayloadSchema,
        MobileWebWorkspaceUpdateResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  remove(payload: MobileWebWorkspaceRemovePayload): Promise<MobileWebWorkspaceRemoveResult> {
    return this.requests
      .request(
        'workspace',
        'remove',
        payload,
        MobileWebWorkspaceRemovePayloadSchema,
        MobileWebWorkspaceRemoveResultSchema
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  settingsSnapshot(): Promise<{ settings: MobileWebWorkspaceViewSettings | null }> {
    return this.requests.request(
      'settings',
      'snapshot',
      {},
      MobileWebWorkspaceSettingsSnapshotPayloadSchema,
      MobileWebWorkspaceSettingsSnapshotResultSchema
    )
  }

  settingsUpdate(payload: MobileWebWorkspaceViewSettings): Promise<null> {
    return this.requests.request(
      'settings',
      'update',
      payload,
      MobileWebWorkspaceSettingsUpdatePayloadSchema,
      MobileWebWorkspaceSettingsUpdateResultSchema
    )
  }
}
