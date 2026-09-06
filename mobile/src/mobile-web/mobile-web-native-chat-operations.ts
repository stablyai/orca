import {
  MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT,
  MobileWebNativeChatFileSearchPayloadSchema,
  MobileWebNativeChatFileSearchResultSchema,
  MobileWebNativeChatOpenFilePayloadSchema,
  MobileWebNativeChatPendingReadPayloadSchema,
  MobileWebNativeChatPendingReadResultSchema,
  MobileWebNativeChatPendingWritePayloadSchema,
  MobileWebNativeChatReadPayloadSchema,
  MobileWebNativeChatReadResultSchema,
  MobileWebNativeChatReadabilityPayloadSchema,
  MobileWebNativeChatReadabilityResultSchema,
  MobileWebRelativePathSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { isFloatingWorkspaceWorktreeId } from '../session/floating-workspace'
import { getRepoIdFromMobileWorktreeId } from '../session/mobile-session-route-helpers'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import {
  assertCurrentMobileWebNativeChatPageBinding,
  resolveFreshMobileWebNativeChatPageBinding
} from './mobile-web-native-chat-binding'
import {
  executeMobileWebNativeChatImageOperation,
  isMobileWebNativeChatImageOperation
} from './mobile-web-native-chat-image-operations'
import {
  executeMobileWebNativeChatTerminalOperation,
  isMobileWebNativeChatTerminalOperation
} from './mobile-web-native-chat-terminal-operations'
import { projectMobileWebNativeChatMessages } from './mobile-web-native-chat-message-projection'

export async function executeMobileWebNativeChatOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  terminalClientId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
  nativeAuthority: Pick<
    MobileWebNativeCapabilityAuthority,
    'sessionChatPendingRead' | 'sessionChatPendingWrite'
  >
}): Promise<unknown> {
  if (isMobileWebNativeChatImageOperation(args.operation)) {
    return executeMobileWebNativeChatImageOperation(args)
  }
  if (isMobileWebNativeChatTerminalOperation(args.operation)) {
    return executeMobileWebNativeChatTerminalOperation(args)
  }
  if (args.operation === 'read') {
    const payload = MobileWebNativeChatReadPayloadSchema.parse(args.payload)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    const response = await args.client.sendRequest('nativeChat.readSession', {
      agent: binding.agent,
      sessionId: binding.providerSessionId,
      limit: payload.limit,
      ...(payload.beforeOffset === undefined ? {} : { beforeOffset: payload.beforeOffset }),
      ...(binding.transcriptPath ? { transcriptPath: binding.transcriptPath } : {}),
      ...(binding.hostTerminalId
        ? { worktreeId: binding.hostWorkspaceId, terminal: binding.hostTerminalId }
        : {})
    })
    const messages =
      response.ok && isRecord(response.result)
        ? projectMobileWebNativeChatMessages(response.result.messages)
        : null
    if (!response.ok || !isRecord(response.result) || !messages) {
      throw new MobileWebBrokerError('host_error')
    }
    return MobileWebNativeChatReadResultSchema.parse({
      messages,
      hasMore: response.result.hasMore === true,
      ...(safeOffset(response.result.beforeOffset) === undefined
        ? {}
        : { beforeOffset: response.result.beforeOffset }),
      ...(response.result.lifecycle === undefined ? {} : { lifecycle: response.result.lifecycle })
    })
  }
  if (args.operation === 'pendingRead') {
    const payload = MobileWebNativeChatPendingReadPayloadSchema.parse(args.payload)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    if (!args.nativeAuthority.sessionChatPendingRead) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    return MobileWebNativeChatPendingReadResultSchema.parse({
      deliveries: await args.nativeAuthority.sessionChatPendingRead(
        binding.hostWorkspaceId,
        binding.hostTabId,
        binding.providerSessionId
      )
    })
  }
  if (args.operation === 'pendingWrite') {
    const payload = MobileWebNativeChatPendingWritePayloadSchema.parse(args.payload)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    if (!args.nativeAuthority.sessionChatPendingWrite) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    assertCurrentMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId,
      binding
    )
    await args.nativeAuthority.sessionChatPendingWrite(
      binding.hostWorkspaceId,
      binding.hostTabId,
      binding.providerSessionId,
      payload.deliveries
    )
    return null
  }
  if (args.operation === 'fileSearch') {
    const payload = MobileWebNativeChatFileSearchPayloadSchema.parse(args.payload)
    await resolveFreshMobileWebNativeChatPageBinding(args, payload.workspaceId, payload.sessionId)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('files.searchPaths', {
      worktree: `id:${hostWorkspaceId}`,
      query: payload.query,
      limit: MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT
    })
    if (!response.ok || !isRecord(response.result) || !Array.isArray(response.result.files)) {
      throw new MobileWebBrokerError('host_error')
    }
    const paths = response.result.files.flatMap((value): string[] => {
      if (!isRecord(value)) {
        return []
      }
      const parsed = MobileWebRelativePathSchema.safeParse(value.relativePath)
      return parsed.success ? [parsed.data] : []
    })
    return MobileWebNativeChatFileSearchResultSchema.parse({
      paths: paths.slice(0, MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT)
    })
  }
  if (args.operation === 'openFile') {
    const payload = MobileWebNativeChatOpenFilePayloadSchema.parse(args.payload)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const resolved = await args.client.sendRequest('files.resolveTerminalPath', {
      worktree: `id:${hostWorkspaceId}`,
      pathText: payload.pathText,
      ...(binding.hostTerminalId ? { terminal: binding.hostTerminalId } : {})
    })
    const relativePath = resolvedWorktreePath(resolved)
    if (relativePath) {
      assertCurrentMobileWebNativeChatPageBinding(
        args,
        payload.workspaceId,
        payload.sessionId,
        binding
      )
      await args.client.sendRequest('files.open', {
        worktree: `id:${hostWorkspaceId}`,
        relativePath
      })
    }
    return null
  }
  if (args.operation === 'readability') {
    const payload = MobileWebNativeChatReadabilityPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    if (isFloatingWorkspaceWorktreeId(hostWorkspaceId)) {
      return MobileWebNativeChatReadabilityResultSchema.parse({ readable: true })
    }
    const response = await args.client.sendRequest('repo.list')
    const repos =
      response.ok && isRecord(response.result) && Array.isArray(response.result.repos)
        ? response.result.repos
        : []
    const repoId = getRepoIdFromMobileWorktreeId(hostWorkspaceId)
    const repo = repos.find((value) => isRecord(value) && value.id === repoId)
    const connectionId = isRecord(repo) ? repo.connectionId : undefined
    return MobileWebNativeChatReadabilityResultSchema.parse({
      readable: connectionId === null || typeof connectionId === 'string'
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function resolvedWorktreePath(
  response: Awaited<ReturnType<RpcClient['sendRequest']>>
): string | null {
  if (!response.ok || !isRecord(response.result)) {
    return null
  }
  const target = response.result.openTarget
  const relativePath =
    isRecord(target) && target.kind === 'worktree-file'
      ? target.relativePath
      : response.result.relativePath
  const parsed = MobileWebRelativePathSchema.safeParse(relativePath)
  return response.result.exists === true && response.result.isDirectory !== true && parsed.success
    ? parsed.data
    : null
}

function safeOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
