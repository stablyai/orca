import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  readTerminalStreamFrameId,
  writeTerminalStreamFrameId
} from '../../../shared/terminal-stream-protocol'

const STRIPPED_ENVELOPE_FIELDS = new Set(['deviceToken', 'executionHost'])

// Swap every desktop-token occurrence, including composite subscription ids; field lists silently rot.
export function rewriteRelayedPhoneRequest(
  frame: string,
  phoneDesktopToken: string,
  phoneHostToken: string,
  requestId?: string
): string {
  const parsed: unknown = JSON.parse(frame.split(phoneDesktopToken).join(phoneHostToken))
  if (!isRecord(parsed)) {
    throw new Error('relayed_phone_frame_not_an_object')
  }
  // Socket authentication owns host identity; routing targets belong only to the desktop.
  const forwarded = Object.fromEntries(
    Object.entries(parsed).filter(([field]) => !STRIPPED_ENVELOPE_FIELDS.has(field))
  )
  return JSON.stringify(requestId === undefined ? forwarded : { ...forwarded, id: requestId })
}

// Servers expose client-placed tabs only with this capability; mobile scope still cannot host them.
export function relayedPhoneCapabilities(capabilities: readonly string[]): readonly string[] {
  return capabilities.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)
    ? capabilities
    : [...capabilities, BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
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
  private readonly openRequests = new Map<string, { hostStreamIds: number[]; swallow: boolean }>()
  private readonly desktopStreamIds = new Map<number, number>()

  constructor(private readonly allocateStreamId: () => number) {}

  noteForwarded(requestId: string, options: { swallowReplies?: boolean } = {}): void {
    this.openRequests.set(requestId, {
      hostStreamIds: [],
      swallow: options.swallowReplies === true
    })
  }

  takeOpenRequestIds(): string[] {
    const ids = [...this.openRequests].filter(([, open]) => !open.swallow).map(([id]) => id)
    this.openRequests.clear()
    this.desktopStreamIds.clear()
    return ids
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
    const result = parsed.result
    let renumbered = false
    if (open && isRecord(result) && typeof result.streamId === 'number') {
      result.streamId = this.desktopStreamId(result.streamId, open.hostStreamIds)
      renumbered = true
    }
    // Unsubscribe sends no end; cap retained streams until link closure.
    if (open && (parsed.streaming !== true || (isRecord(result) && result.type === 'end'))) {
      this.finish(parsed.id, open.hostStreamIds)
    }
    if (open?.swallow) {
      return null
    }
    return renumbered ? JSON.stringify(parsed) : plaintext
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
