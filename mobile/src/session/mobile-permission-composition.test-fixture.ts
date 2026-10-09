import { expect, vi } from 'vitest'
import type { AgentSessionPermissionSeed } from '../../../src/shared/agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'

function success(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'host' } }
}

export function permissionHost() {
  const replies: ((reply: RpcResponse) => void)[] = []
  const failures: ((error: Error) => void)[] = []
  let hold: (reply: RpcResponse) => void = () => {}
  const holdReply = new Promise<RpcResponse>((resolve) => {
    hold = resolve
  })
  // The host's answer to every request, by method; a vi.fn so tests can assert on or replace it.
  const handleRequest = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'agentSession.modelCatalog') {
      // The host's model list has not answered: the model pill stays the quiet placeholder.
      return new Promise<RpcResponse>(() => {})
    }
    if (method === 'agentSession.options') {
      return new Promise<RpcResponse>((resolve, reject) => {
        replies.push(resolve)
        failures.push(reject)
      })
    }
    if (method === 'agentSession.hold') {
      return holdReply
    }
    if (method === 'agentSession.setOption') {
      const value =
        typeof params === 'object' && params !== null && 'value' in params
          ? params.value
          : undefined
      return success({ ok: true, value: { key: 'permissionMode', value } })
    }
    return success({})
  })
  const client = createFakeRpcClient({}, handleRequest)
  const publish = (event: AgentSessionSubscribeEvent): void => {
    const stream = client.streams.findLast((open) => open.method === 'agentSession.subscribe')
    if (!stream) {
      throw new Error('No subscription')
    }
    stream.emit(event)
  }
  return {
    client,
    handleRequest,
    replies,
    failures,
    attach: () => hold(success({})),
    publish,
    failReads: () => failures.forEach((reject) => reject(new Error('Host unavailable')))
  }
}

/** The quiet, unpickable model placeholder: what shows before any model list answers. */
export const MODEL_PLACEHOLDER_ONLY = [
  expect.objectContaining({ id: 'model', settable: false, valueSource: 'unknown' })
]

export function permissionSnapshot(
  mode: AgentSessionPermissionSeed['mode'],
  fence = 7,
  sessionId = 'chat'
): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId,
    fence,
    permissionMode: mode,
    page: {
      sessionId,
      epoch: 'epoch',
      direction: 'tail',
      fence,
      items: [],
      removedItemIds: [],
      submissions: [],
      hasOlder: false,
      hasNewer: false,
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch', sequence: 0 } },
      liveCursor: { epoch: 'epoch', sequence: 0 }
    }
  }
}

export function permissionOptions(mode: string): RpcResponse {
  return success({
    models: [{ id: 'm', label: 'M', isDefault: true, efforts: [] }],
    current: { model: 'm' },
    permissionModes: { current: mode, supported: ['ask', 'auto', 'bypass'] }
  })
}

export function permissionBatch(
  mode: AgentSessionPermissionSeed['mode'],
  sequence = 0
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'chat',
    fence: 7,
    permissionMode: mode,
    batch: { cursor: { epoch: 'epoch', sequence }, items: [], removedItemIds: [], submissions: [] }
  }
}

export type PermissionProbeProps = {
  agent: string
  client: RpcClient
  permissionSeed?: AgentSessionPermissionSeed
  open?: boolean
  connected?: boolean
  sessionKey?: string
  sessionId?: string
}

export function usePermissionComposition(props: PermissionProbeProps) {
  const { agent, client, permissionSeed, open = true, sessionKey = 'host:chat' } = props
  const enabled = open
  const sessionId = open ? (props.sessionId ?? 'chat') : null
  const structured = useMobileStructuredAgentSession({
    agent,
    client,
    sessionId,
    enabled,
    connected: props.connected ?? true,
    sourceIdentity: sessionKey,
    permissionSeed,
    hostSupport: null,
    onSendError: () => {}
  })
  const { nativeChatSessionOptions } = useMobileNativeChatSessionOptionController({
    client,
    agent,
    activeChatStructured: enabled,
    activeSessionTabId: sessionId,
    dispatchCommand: async () => 'rejected',
    hostId: 'host',
    worktreeId: 'folder:workspace',
    isTabChatView: () => true,
    isWorking: false,
    reportedModel: null,
    structured,
    toggleTabChatView: () => {}
  })
  return { structured, nativeChatSessionOptions }
}
