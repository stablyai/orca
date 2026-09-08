import {
  MobileWebWorkspaceActivationResultSchema,
  MobileWebWorkspaceSnapshotPayloadSchema,
  MobileWebWorkspaceSnapshotResultSchema,
  MobileWebWorkspaceViewSettingsSchema,
  type MobileWebWorkspaceActivationPayload,
  type MobileWebWorkspaceActivationResult,
  type MobileWebWorkspaceRemovePayload,
  type MobileWebWorkspaceRemoveResult,
  type MobileWebWorkspaceSnapshotPayload,
  type MobileWebWorkspaceSnapshotResult,
  type MobileWebWorkspaceUpdatePayload,
  type MobileWebWorkspaceUpdateResult,
  type MobileWebWorkspaceViewSettings
} from '../../shared/mobile-web/bridge-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import {
  mobileWebHostRepositoryCatalog,
  type MobileWebHostRepositoryCatalog
} from './mobile-web-host-repository-list'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

function invalidMessage(): MobileWebBridgeClientError {
  return new MobileWebBridgeClientError('invalid_message', false)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMessage()
  }
  return value as Record<string, unknown>
}

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
          throw invalidMessage()
        }
        return result
      })
  }

  activate(
    payload: MobileWebWorkspaceActivationPayload
  ): Promise<MobileWebWorkspaceActivationResult> {
    // `navigation: 'caller'` keeps a phone activation off the desktop's own foreground selection.
    return requestMobileWebHost(this.requests, 'worktree.activate', payload.workspaceId, {
      notifyClients: false,
      navigation: 'caller'
    }).then((result) => {
      const parsed = MobileWebWorkspaceActivationResultSchema.safeParse({
        ...asRecord(result),
        workspaceId: payload.workspaceId
      })
      if (!parsed.success) {
        throw invalidMessage()
      }
      return parsed.data
    })
  }

  repositories(): Promise<MobileWebHostRepositoryCatalog> {
    return requestMobileWebHost(this.requests, 'repo.list', undefined, {}).then(
      mobileWebHostRepositoryCatalog
    )
  }

  update(payload: MobileWebWorkspaceUpdatePayload): Promise<MobileWebWorkspaceUpdateResult> {
    const request =
      payload.mutation === 'pin'
        ? requestMobileWebHost(this.requests, 'worktree.set', payload.workspaceId, {
            isPinned: payload.pinned
          })
        : requestMobileWebHost(this.requests, 'worktree.sleep', payload.workspaceId, {})
    return request.then(() => ({ workspaceId: payload.workspaceId, updated: true as const }))
  }

  remove(payload: MobileWebWorkspaceRemovePayload): Promise<MobileWebWorkspaceRemoveResult> {
    return requestMobileWebHost(this.requests, 'worktree.rm', payload.workspaceId, {
      force: true
    }).then((result) => {
      if (asRecord(result).removed !== true) {
        throw invalidMessage()
      }
      return { workspaceId: payload.workspaceId, removed: true as const }
    })
  }

  settingsSnapshot(): Promise<{ settings: MobileWebWorkspaceViewSettings | null }> {
    return requestMobileWebHost(this.requests, 'ui.get', undefined, {}).then((result) => {
      const ui = asRecord(result).ui
      if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) {
        return { settings: null }
      }
      const parsed = MobileWebWorkspaceViewSettingsSchema.safeParse(ui)
      if (!parsed.success) {
        throw invalidMessage()
      }
      return { settings: parsed.data }
    })
  }

  settingsUpdate(payload: MobileWebWorkspaceViewSettings): Promise<null> {
    // `ui.set` merges a partial state, so sending only the view keys leaves the rest untouched.
    const parsed = MobileWebWorkspaceViewSettingsSchema.safeParse(payload)
    if (!parsed.success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(this.requests, 'ui.set', undefined, parsed.data).then(() => null)
  }
}
