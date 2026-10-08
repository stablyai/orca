import {
  readTerminalStreamFrameId,
  writeTerminalStreamFrameId
} from '../../../shared/terminal-stream-protocol'

const STRIPPED_ENVELOPE_FIELDS = new Set(['deviceToken', 'executionHost'])

// Why: the phone stamps its desktop token into params (client.id, mobileClient.id, `${terminal}:${token}`
// subscription ids). A field list would rot silently, so every occurrence in the text is swapped.
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
  // Why: the host binds identity to the authenticated socket; the routing target is the desktop's only.
  const forwarded = Object.fromEntries(
    Object.entries(parsed).filter(([field]) => !STRIPPED_ENVELOPE_FIELDS.has(field))
  )
  return JSON.stringify(requestId === undefined ? forwarded : { ...forwarded, id: requestId })
}

/**
 * The host's replies on one relayed socket, passed through except for stream ids. Why renumber:
 * every host allocates terminal stream ids from 1, and the phone routes binary frames by id
 * across everything its desktop socket carries.
 */
export class RelayedPhoneReplies {
  // Why swallow: requests the relay sends on its own behalf have no phone waiting on them.
  private readonly openRequests = new Map<string, { hostStreamIds: number[]; swallow: boolean }>()
  private readonly desktopStreamIds = new Map<number, number>()

  constructor(private readonly allocateStreamId: () => number) {}

  noteForwarded(requestId: string, options: { swallowReplies?: boolean } = {}): void {
    this.openRequests.set(requestId, {
      hostStreamIds: [],
      swallow: options.swallowReplies === true
    })
  }

  /** Request ids still waiting on the host; the caller fails them when the socket ends. */
  takeOpenRequestIds(): string[] {
    const ids = [...this.openRequests].filter(([, open]) => !open.swallow).map(([id]) => id)
    this.openRequests.clear()
    this.desktopStreamIds.clear()
    return ids
  }

  /** The frame to hand the phone, or null to drop it. */
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
    // Why bounded: a stream ended by its own unsubscribe sends no 'end'; it stays until the link closes.
    if (open && (parsed.streaming !== true || (isRecord(result) && result.type === 'end'))) {
      this.finish(parsed.id, open.hostStreamIds)
    }
    if (open?.swallow) {
      return null
    }
    return renumbered ? JSON.stringify(parsed) : plaintext
  }

  /** The frame to hand the phone, or null to drop a terminal frame for a stream it was never told of. */
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
