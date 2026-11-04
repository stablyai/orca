import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { RUNTIME_ORDINARY_MESSAGE_CAPABILITY } from '../../../shared/runtime-ordinary-message-capability'
import { COMPRESSED_FRAMES_CLIENT_CAPABILITY } from '../../../shared/remote-runtime/e2ee/paired-e2ee-compressed-frame'
import {
  readTerminalStreamFrameId,
  writeTerminalStreamFrameId
} from '../../../shared/terminal/stream/terminal-stream-protocol'

const STRIPPED_ENVELOPE_FIELDS = new Set(['deviceToken', 'executionHost'])

const CLIENT_ID_METHODS = new Set([
  'terminal.subscribe',
  'terminal.send',
  'terminal.setDisplayMode',
  'terminal.updateViewport',
  'terminal.unsubscribe',
  'terminal.viewClaudeAgent'
])

// Translate authenticated identity positions; application strings remain opaque.
export function rewriteRelayedPhoneRequest(
  frame: string,
  phoneDesktopToken: string,
  phoneHostToken: string,
  requestId?: string
): string {
  const parsed: unknown = JSON.parse(frame)
  if (!isRecord(parsed)) {
    throw new Error('relayed_phone_frame_not_an_object')
  }
  const params = parsed.params
  if (isRecord(params)) {
    if (
      CLIENT_ID_METHODS.has(String(parsed.method)) &&
      isRecord(params.client) &&
      params.client.id === phoneDesktopToken
    ) {
      params.client = { ...params.client, id: phoneHostToken }
    }
    if (parsed.method === 'terminal.resizeForClient' && params.clientId === phoneDesktopToken) {
      params.clientId = phoneHostToken
    }
    if (
      parsed.method === 'terminal.unsubscribe' &&
      typeof params.subscriptionId === 'string' &&
      params.subscriptionId.endsWith(`:${phoneDesktopToken}`)
    ) {
      params.subscriptionId =
        params.subscriptionId.slice(0, -phoneDesktopToken.length) + phoneHostToken
    }
  }
  // Socket authentication owns host identity; routing targets belong only to the desktop.
  const forwarded = Object.fromEntries(
    Object.entries(parsed).filter(([field]) => !STRIPPED_ENVELOPE_FIELDS.has(field))
  )
  return JSON.stringify(requestId === undefined ? forwarded : { ...forwarded, id: requestId })
}

// Servers expose client-placed tabs only with this capability; mobile scope still cannot host them.
// Withhold compressed frames: they would hide relayed replies and stream ids from the rewriting below.
export function relayedPhoneCapabilities(capabilities: readonly string[]): readonly string[] {
  const forwarded = capabilities.filter(
    (capability) => capability !== COMPRESSED_FRAMES_CLIENT_CAPABILITY
  )
  return forwarded.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)
    ? forwarded
    : [...forwarded, BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
}

export function declareRelayedPhoneCapabilities(frame: string): string {
  const parsed: unknown = JSON.parse(frame)
  const params = isRecord(parsed) ? parsed.params : undefined
  if (!isRecord(parsed) || !isRecord(params) || !Array.isArray(params.clientCapabilities)) {
    return frame
  }
  const clientCapabilities = params.clientCapabilities.filter(
    (capability): capability is string => typeof capability === 'string'
  )
  return JSON.stringify({
    ...parsed,
    params: { ...params, clientCapabilities: relayedPhoneCapabilities(clientCapabilities) }
  })
}

const LAUNCH_METHODS_READING_CHAT_DEFAULT = new Set(['agent.launch', 'agent.launchReplay'])

// The relaying desktop owns the user chat default; older servers strip this additive field.
export function withRelayedLaunchChatDefault(
  frame: string,
  method: string,
  nativeChatDefaultFor: (agent: string) => boolean
): string {
  if (!LAUNCH_METHODS_READING_CHAT_DEFAULT.has(method)) {
    return frame
  }
  const parsed: unknown = JSON.parse(frame)
  if (!isRecord(parsed) || !isRecord(parsed.params)) {
    return frame
  }
  const agent = typeof parsed.params.agent === 'string' ? parsed.params.agent : ''
  return JSON.stringify({
    ...parsed,
    params: { ...parsed.params, nativeChatDefault: nativeChatDefaultFor(agent) }
  })
}

/** Renumber host stream ids: each host starts at 1, but the phone routes all binary frames on one socket. */
export class RelayedPhoneReplies {
  // Relay-owned requests have no phone awaiting their replies.
  private readonly openRequests = new Map<
    string,
    {
      hostStreamIds: number[]
      swallow: boolean
      method?: string
      browserScreencast?: () => boolean
      settle?: (reply: unknown) => void
      cancel?: () => void
    }
  >()
  private ordinaryMessages = false
  private readonly desktopStreamIds = new Map<number, number>()

  constructor(private readonly allocateStreamId: () => number) {}

  noteForwarded(
    requestId: string,
    options: { swallowReplies?: boolean; method?: string; browserScreencast?: () => boolean } = {}
  ): void {
    this.openRequests.set(requestId, {
      hostStreamIds: [],
      method: options.method,
      swallow: options.swallowReplies === true,
      browserScreencast: options.browserScreencast
    })
  }

  request(id: string, send: () => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openRequests.delete(id)
        reject(new Error('Timed out confirming the executing Orca server.'))
      }, timeoutMs)
      this.openRequests.set(id, {
        hostStreamIds: [],
        swallow: true,
        settle: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        cancel: () => {
          clearTimeout(timer)
          reject(new Error('The executing Orca server connection changed.'))
        }
      })
      try {
        if (!send()) {
          this.openRequests.get(id)?.cancel?.()
          this.openRequests.delete(id)
        }
      } catch (error) {
        clearTimeout(timer)
        this.openRequests.delete(id)
        reject(error)
      }
    })
  }

  takeOpenRequestIds(): string[] {
    const ids = [...this.openRequests].filter(([, open]) => !open.swallow).map(([id]) => id)
    for (const open of this.openRequests.values()) {
      open.cancel?.()
    }
    this.openRequests.clear()
    this.desktopStreamIds.clear()
    this.ordinaryMessages = false
    return ids
  }

  supportsOrdinaryMessages(): boolean {
    return this.ordinaryMessages
  }

  /** Return the phone frame, or null to drop it. */
  text(plaintext: string): string | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext)
    } catch {
      return plaintext
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') {
      return plaintext
    }
    const open = this.openRequests.get(parsed.id)
    open?.settle?.(parsed)
    const result = parsed.result
    if (
      open?.method === 'status.get' &&
      parsed.ok === true &&
      isRecord(result) &&
      Array.isArray(result.capabilities)
    ) {
      this.ordinaryMessages = result.capabilities.includes(RUNTIME_ORDINARY_MESSAGE_CAPABILITY)
    }
    let rewritten = false
    if (
      open?.browserScreencast?.() &&
      parsed.ok === true &&
      isRecord(result) &&
      Array.isArray(result.capabilities) &&
      !result.capabilities.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
    ) {
      result.capabilities = [...result.capabilities, BROWSER_SCREENCAST_RUNTIME_CAPABILITY]
      rewritten = true
    }
    if (open && isRecord(result) && typeof result.streamId === 'number') {
      result.streamId = this.desktopStreamId(result.streamId, open.hostStreamIds)
      rewritten = true
    }
    // Unsubscribe sends no end; cap retained streams until link closure.
    if (open && (parsed.streaming !== true || (isRecord(result) && result.type === 'end'))) {
      this.finish(parsed.id, open.hostStreamIds)
    }
    if (open?.swallow) {
      return null
    }
    return rewritten ? JSON.stringify(parsed) : plaintext
  }

  /** Drop terminal frames for streams never announced to the phone. */
  binary(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> | null {
    const hostStreamId = readTerminalStreamFrameId(bytes)
    if (hostStreamId === null) {
      return bytes
    }
    const desktopStreamId = this.desktopStreamIds.get(hostStreamId)
    if (desktopStreamId === undefined) {
      return null
    }
    writeTerminalStreamFrameId(bytes, desktopStreamId)
    return bytes
  }

  private desktopStreamId(hostStreamId: number, requestStreamIds: number[]): number {
    const known = this.desktopStreamIds.get(hostStreamId)
    if (known !== undefined) {
      return known
    }
    const allocated = this.allocateStreamId()
    this.desktopStreamIds.set(hostStreamId, allocated)
    requestStreamIds.push(hostStreamId)
    return allocated
  }

  private finish(requestId: string, hostStreamIds: number[]): void {
    this.openRequests.delete(requestId)
    for (const hostStreamId of hostStreamIds) {
      this.desktopStreamIds.delete(hostStreamId)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
