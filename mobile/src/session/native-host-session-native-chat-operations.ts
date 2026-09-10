import type { RpcClient } from '../transport/rpc-client'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat-stream-unsubscribe'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { isMobileNativeChatTranscriptReadable } from './mobile-native-chat-eligibility'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { rankSuggestions } from './mobile-native-chat-autocomplete'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'

const FILE_RESULT_LIMIT = 16

export function nativeHostSessionNativeChatOperations(
  client: RpcClient
): HostSessionNativeChatOperations {
  let searchSupported: boolean | null = null
  // Why: the legacy full-inventory fallback is per workspace — one shared list makes
  // `@` autocomplete in a second workspace suggest the first workspace's files.
  const legacyPathsByWorkspace = new Map<string, string[]>()
  const legacyLoadByWorkspace = new Map<string, Promise<string[] | null>>()
  const legacyGenerationByWorkspace = new Map<string, number>()
  return {
    async readability(workspaceId) {
      if (isFloatingWorkspaceWorktreeId(workspaceId)) {
        return true
      }
      const response = await client.sendRequest('repo.list')
      const repos = response.ok
        ? ((response.result as { repos?: { id: string; connectionId?: string | null }[] }).repos ??
          [])
        : []
      const repo = repos.find(
        (candidate) => candidate.id === getRepoIdFromMobileWorktreeId(workspaceId)
      )
      return repo ? isMobileNativeChatTranscriptReadable(repo.connectionId ?? null) : false
    },
    subscribe(target, limit, onEvent) {
      return client.subscribe(
        'nativeChat.subscribe',
        {
          ...nativeChatReadParams(target, limit),
          capabilities: { transcriptPending: 1 },
          subscriptionId: buildNativeChatSubscriptionId(target.agent, target.sessionId)
        },
        (value) => onEvent(value as Parameters<typeof onEvent>[0])
      )
    },
    async read(target, limit, beforeOffset) {
      try {
        const response = await client.sendRequest('nativeChat.readSession', {
          ...nativeChatReadParams(target, limit),
          ...(beforeOffset === undefined ? {} : { beforeOffset })
        })
        return response.ok
          ? (response.result as Awaited<ReturnType<HostSessionNativeChatOperations['read']>>)
          : { error: response.error.message }
      } catch {
        return { error: 'Transcript read failed' }
      }
    },
    stop(target, deadline) {
      return sendStopEscape(target, client, deadline)
    },
    resetFileSearchCache(workspaceId) {
      searchSupported = null
      legacyPathsByWorkspace.delete(workspaceId)
      legacyLoadByWorkspace.delete(workspaceId)
      legacyGenerationByWorkspace.set(
        workspaceId,
        (legacyGenerationByWorkspace.get(workspaceId) ?? 0) + 1
      )
    },
    async searchFiles(target, query) {
      if (searchSupported !== false) {
        const response = await client.sendRequest('files.searchPaths', {
          worktree: `id:${target.workspaceId}`,
          query,
          limit: FILE_RESULT_LIMIT
        })
        if (response.ok) {
          searchSupported = true
          return extractPaths(response.result)
        }
        if (response.error.code !== 'method_not_found') {
          // Null, not empty: an empty list is a real answer the caller caches, and caching a
          // refusal would keep autocomplete dead for that prefix until the client changes.
          return null
        }
        searchSupported = false
      }
      let legacyPaths = legacyPathsByWorkspace.get(target.workspaceId)
      if (!legacyPaths) {
        let legacyLoad = legacyLoadByWorkspace.get(target.workspaceId)
        if (!legacyLoad) {
          // Older hosts expose only the full inventory RPC; overlapping queries must
          // share one slow local/SSH read.
          const generation = legacyGenerationByWorkspace.get(target.workspaceId) ?? 0
          const request = client
            .sendRequest('files.list', {
              worktree: `id:${target.workspaceId}`
            })
            .then((response) => {
              if (
                !response.ok ||
                (legacyGenerationByWorkspace.get(target.workspaceId) ?? 0) !== generation
              ) {
                return null
              }
              const paths = extractPaths(response.result)
              legacyPathsByWorkspace.set(target.workspaceId, paths)
              return paths
            })
            .finally(() => {
              if (
                legacyLoadByWorkspace.get(target.workspaceId) === request &&
                !legacyPathsByWorkspace.has(target.workspaceId)
              ) {
                legacyLoadByWorkspace.delete(target.workspaceId)
              }
            })
          legacyLoad = request
          legacyLoadByWorkspace.set(target.workspaceId, request)
        }
        const paths = await legacyLoad
        if (!paths) {
          return null
        }
        legacyPaths = paths
      }
      return rankSuggestions(legacyPaths, query, FILE_RESULT_LIMIT)
    }
  }
}

function nativeChatReadParams(target: HostSessionNativeChatTarget, limit: number) {
  return {
    agent: target.agent,
    sessionId: target.sessionId,
    limit,
    ...(target.transcriptPath ? { transcriptPath: target.transcriptPath } : {}),
    ...(target.terminalId ? { worktreeId: target.workspaceId, terminal: target.terminalId } : {})
  }
}

/** Stop keeps its own send rather than the shared chat write: the shared one refuses to start
 *  under a 2s residual budget, and Stop is worth attempting on whatever is left. It carries no
 *  `enter`, so the Escape cannot submit whatever the agent had parked on its input line. */
async function sendStopEscape(
  target: HostSessionNativeChatTarget,
  client: RpcClient,
  deadline?: number
): Promise<MobileNativeChatSendOutcome> {
  if (!target.terminalId) {
    return 'rejected'
  }
  const handle = target.terminalId
  const timeoutMs =
    deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : deadline - Date.now()
  if (timeoutMs <= 0) {
    return 'rejected'
  }
  try {
    const response = await client.sendRequest(
      'terminal.send',
      {
        terminal: handle,
        text: String.fromCharCode(27),
        ...(target.clientId ? { client: { id: target.clientId, type: 'mobile' as const } } : {})
      },
      // Why: without this the call parks indefinitely on reconnect, so "Stop not sent" never
      // appears and a stale Escape can land minutes later, into a composer holding fresh text.
      { timeoutMs, budgetSpansConnect: true }
    )
    if (!isTerminalSendRpcAccepted(response)) {
      return 'rejected'
    }
    // A deliberate Stop is human input; it takes the worker over like any other key.
    reportWorkerTerminalUserInput(client, handle)
    return 'accepted'
  } catch (error) {
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

function extractPaths(result: unknown): string[] {
  const files = (result as { files?: Array<{ relativePath?: string }> }).files ?? []
  return files
    .map((file) => file.relativePath ?? '')
    .filter((path): path is string => path.length > 0)
}
