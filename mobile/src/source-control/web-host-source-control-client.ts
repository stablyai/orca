import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MobileWebBridgeClientError } from '../../../src/mobile-web/src/mobile-web-bridge-client-error'
import type { RpcClient } from '../transport/rpc-client'
import {
  mutateWebHostSourceControlRequest,
  WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED
} from './web-host-source-control-mutations'
import {
  readWebHostSourceControlRequest,
  WEB_HOST_SOURCE_CONTROL_REQUEST_UNHANDLED
} from './web-host-source-control-reads'
import {
  hostedSourceControlFailure,
  hostedSourceControlResponse,
  hostedSourceControlSuccess
} from './web-host-source-control-response'
import {
  createWebHostProviderReviewCache,
  handleWebHostProviderReviewRequest,
  WEB_HOST_PROVIDER_REVIEW_UNHANDLED
} from './web-host-provider-review-requests'
import {
  createWebHostProviderReviewEligibilityCache,
  handleWebHostProviderReviewCreation,
  WEB_HOST_PROVIDER_REVIEW_CREATION_UNHANDLED
} from './web-host-provider-review-creation'
import { createWebHostSourceControlStatusSnapshot } from './web-host-source-control-status-snapshot'

export function webHostSourceControlClient(
  bridgeClient: MobileWebBridgeClient,
  workspaceId: string
): RpcClient {
  const providerReviewCache = createWebHostProviderReviewCache()
  const providerReviewEligibilityCache = createWebHostProviderReviewEligibilityCache()
  const statusSnapshot = createWebHostSourceControlStatusSnapshot(bridgeClient, workspaceId)
  return {
    async sendRequest(method, input) {
      if (!matchesBoundWorkspace(input, workspaceId)) {
        return hostedSourceControlFailure('forbidden')
      }
      const params = isRecord(input) ? input : {}
      if (method === 'files.openDiff') {
        return openHostedSourceControlDiff(bridgeClient, workspaceId, params)
      }
      return hostedSourceControlResponse(async () => {
        if (method === 'files.open') {
          await bridgeClient.fileOpen({
            workspaceId,
            relativePath: requiredString(params.relativePath)
          })
          return null
        }
        if (method === 'session.tabs.list') {
          return hostedSessionTabSnapshot(await bridgeClient.sessionSnapshot({ workspaceId }))
        }
        if (method === 'session.tabs.activate') {
          return hostedSessionTabSnapshot(
            await bridgeClient.sessionActivate({
              workspaceId,
              tabId: requiredString(params.tabId)
            })
          )
        }
        const creation = await handleWebHostProviderReviewCreation({
          client: bridgeClient,
          workspaceId,
          method,
          params,
          eligibilityCache: providerReviewEligibilityCache,
          statusSnapshot
        })
        if (creation !== WEB_HOST_PROVIDER_REVIEW_CREATION_UNHANDLED) {
          return creation
        }
        const provider = await handleWebHostProviderReviewRequest({
          client: bridgeClient,
          workspaceId,
          method,
          params,
          cache: providerReviewCache,
          eligibilityCache: providerReviewEligibilityCache,
          statusSnapshot
        })
        if (provider !== WEB_HOST_PROVIDER_REVIEW_UNHANDLED) {
          return provider
        }
        const read = await readWebHostSourceControlRequest({
          client: bridgeClient,
          workspaceId,
          method,
          params,
          statusSnapshot
        })
        if (read !== WEB_HOST_SOURCE_CONTROL_REQUEST_UNHANDLED) {
          return read
        }
        const mutation = await mutateWebHostSourceControlRequest({
          client: bridgeClient,
          workspaceId,
          method,
          params
        })
        if (mutation !== WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED) {
          return mutation
        }
        throw new Error('unsupported_operation')
      })
    },
    subscribe() {
      return () => {}
    },
    updateTerminalSubscriptionViewport() {},
    sendTerminalBinaryFrame() {
      return false
    },
    getState() {
      return 'connected'
    },
    getReconnectAttempt() {
      return 0
    },
    getLastConnectedAt() {
      return Date.now()
    },
    onStateChange() {
      return () => {}
    },
    notifyForeground() {},
    close() {}
  }
}

async function openHostedSourceControlDiff(
  bridgeClient: MobileWebBridgeClient,
  workspaceId: string,
  params: Record<string, unknown>
) {
  try {
    await bridgeClient.sourceControlReviewOpen({
      workspaceId,
      relativePath: requiredString(params.relativePath),
      scope: params.staged === true ? 'staged' : 'unstaged'
    })
    return hostedSourceControlSuccess(null)
  } catch (error) {
    const code =
      error instanceof MobileWebBridgeClientError && error.code === 'unsupported_capability'
        ? 'method_not_found'
        : 'host_error'
    return hostedSourceControlFailure(code)
  }
}

function matchesBoundWorkspace(input: unknown, workspaceId: string): boolean {
  if (!isRecord(input)) {
    return true
  }
  const selector = input.worktree
  return selector === undefined || selector === `id:${workspaceId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid_request')
  }
  return value
}

function hostedSessionTabSnapshot(
  snapshot: Awaited<ReturnType<MobileWebBridgeClient['sessionSnapshot']>>
) {
  return {
    worktree: snapshot.workspaceId,
    activeTabId: snapshot.activeTabId,
    activeTabType: snapshot.activeTabType,
    tabs: snapshot.tabs
  }
}
