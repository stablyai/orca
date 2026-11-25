import type { ProviderRelayAttachResult } from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'
import { jsonRpcAnswerId } from '../../provider-relay/relayed-json-rpc-lines'
import { ACP_MESSAGE_CHUNKS, ACP_MESSAGE_ENDS, acpSessionUpdateFields } from './acp-relay-ack-floor'

const PROMPT = 'session/prompt'

/** More messages than this in one cut replay can't be real; later ones read as started. */
const MAX_SEEN_MESSAGES = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * ACP rows of streamed text are keyed by message id; a message has no start line, so the one a
 * cut replay starts inside is the first one it shows before a call, plan, user chunk or another
 * message, and only that one continues under `<tag>:<message id>`. Messages without ids are
 * numbered within their turn, and a cut turn numbers them anew (`replayedWhole`).
 */
export class AcpRelayItemContinuation implements ProviderRelayItemContinuation {
  private readonly seen = new Set<string>()
  private boundary = false

  /** Each attach's replay is read from its own first line. */
  reset(): void {
    this.seen.clear()
    this.boundary = false
  }

  item(line: string): { key: string; start: boolean; end: boolean } | null {
    const update = acpSessionUpdateFields(line)
    const kind = update?.sessionUpdate
    if (!update || !kind) {
      return null
    }
    if (ACP_MESSAGE_ENDS.has(kind)) {
      this.boundary = true
      return null
    }
    if (!ACP_MESSAGE_CHUNKS.has(kind) || update.messageId === undefined) {
      return null
    }
    const key = JSON.stringify([update.sessionId, update.messageId])
    if (this.seen.has(key)) {
      return { key, start: false, end: false }
    }
    const start = this.boundary || this.seen.size > 0
    const full = this.seen.size >= MAX_SEEN_MESSAGES
    if (!full) {
      this.seen.add(key)
    }
    return { key, start: start || full, end: false }
  }

  rekey(line: string, tag: string): string {
    try {
      const parsed: unknown = JSON.parse(line)
      const message = isRecord(parsed) ? parsed : null
      const params = message && isRecord(message.params) ? message.params : null
      const update = params && isRecord(params.update) ? params.update : null
      if (!message || !params || !update || typeof update.messageId !== 'string') {
        return line
      }
      const moved = { ...update, messageId: `${tag}:${update.messageId}` }
      return JSON.stringify({ ...message, params: { ...params, update: moved } })
    } catch {
      return line
    }
  }

  /** The earlier app's prompts whose turn starts before a replay the daemon cut: the cursor may be
   *  inside one of their messages, so the continuation reads until each is answered. A replay the
   *  daemon didn't cut starts at each open item's first line (the ack floor keeps it), so none. */
  openAt(result: ProviderRelayAttachResult): string[] | null {
    if (result.truncatedThrough === undefined) {
      return null
    }
    const cut = (result.outstanding ?? []).filter(
      (request) => request.method === PROMPT && !request.replayedWhole
    )
    return cut.length > 0 ? cut.map((request) => JSON.stringify(request.id)) : null
  }

  settles(line: string): string | null {
    const id = jsonRpcAnswerId(line)
    return id === null ? null : JSON.stringify(id)
  }

  /** The moved chunk itself opens the continuation for the floor. */
  start(line: string, tag: string): string {
    return this.rekey(line, tag)
  }
}
