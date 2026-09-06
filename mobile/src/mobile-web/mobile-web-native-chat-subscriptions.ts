import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import {
  MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES,
  MobileWebNativeChatEventSchema,
  MobileWebNativeChatSubscribePayloadSchema,
  type MobileWebNativeChatEvent
} from '../../../src/shared/mobile-web/native-chat-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { resolveFreshMobileWebNativeChatBinding } from './mobile-web-native-chat-binding'
import { projectMobileWebNativeChatMessages } from './mobile-web-native-chat-message-projection'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type TranscriptRecord = MobileWebSubscriptionRecord & {
  hostWorkspaceId: string
  pageSessionId: string
}

type NativeChatLedgerConfig = MobileWebSubscriptionLedgerConfig<MobileWebNativeChatEvent> & {
  nativeChatAuthority: MobileWebNativeChatAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
}

export class MobileWebNativeChatSubscriptions extends MobileWebSubscriptionLedger<
  MobileWebNativeChatEvent,
  TranscriptRecord
> {
  constructor(private readonly config: NativeChatLedgerConfig) {
    super({ ...config, operationKey: 'nativeChat.subscribe' })
  }

  async start(args: {
    requestId: string
    subscriptionId: string
    payload: unknown
    client: RpcClient
    isRequestActive: () => boolean
  }): Promise<void> {
    const payload = MobileWebNativeChatSubscribePayloadSchema.parse(args.payload)
    this.admit(args.subscriptionId)
    const hostWorkspaceId = this.config.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const binding = await resolveFreshMobileWebNativeChatBinding({
      client: args.client,
      hostWorkspaceId,
      sessionId: payload.sessionId,
      nativeChatAuthority: this.config.nativeChatAuthority
    })
    if (!args.isRequestActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    const record: TranscriptRecord = {
      ...this.newRecord(args.requestId),
      hostWorkspaceId,
      pageSessionId: payload.sessionId
    }
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe(
        'nativeChat.subscribe',
        {
          agent: binding.agent,
          sessionId: binding.providerSessionId,
          limit: payload.limit,
          subscriptionId: args.subscriptionId,
          ...(binding.transcriptPath ? { transcriptPath: binding.transcriptPath } : {}),
          ...(binding.hostTerminalId
            ? { worktreeId: binding.hostWorkspaceId, terminal: binding.hostTerminalId }
            : {})
        },
        (event) => this.receive(args.subscriptionId, record, event)
      )
    )
  }

  private receive(subscriptionId: string, record: TranscriptRecord, value: unknown): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    try {
      this.config.nativeChatAuthority.resolve(record.hostWorkspaceId, record.pageSessionId)
    } catch {
      this.cancel(subscriptionId, { code: 'not_found', retryable: false })
      return
    }
    const event = sanitizeEvent(value)
    if (!event) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    if (encodedByteLength(event) > MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    this.enqueue(subscriptionId, record, event)
  }
}

function sanitizeEvent(value: unknown): MobileWebNativeChatEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }
  const messages = projectMobileWebNativeChatMessages(value.messages)
  const candidate =
    value.type === 'end'
      ? { type: 'end' }
      : value.type === 'error'
        ? { type: 'error', message: value.message }
        : messages &&
            (value.type === 'snapshot' || value.type === 'replacement' || value.type === 'appended')
          ? {
              type: value.type,
              messages,
              ...(typeof value.hasMore === 'boolean' ? { hasMore: value.hasMore } : {}),
              ...(safeOffset(value.beforeOffset) === undefined
                ? {}
                : { beforeOffset: value.beforeOffset }),
              ...(typeof value.error === 'string' ? { error: value.error } : {}),
              ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle })
            }
          : null
  const parsed = MobileWebNativeChatEventSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function safeOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
