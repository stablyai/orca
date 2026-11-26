import {
  RELAY_CUT_KEYS_OVERFLOW,
  type ProviderRelayAttachResult
} from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'
import { jsonRpcAnswerId } from '../../provider-relay/relayed-json-rpc-lines'
import type { AcpInheritedCut } from './acp-relay-ack-floor'
import {
  ACP_MESSAGE_BOUNDARIES,
  ACP_MESSAGE_CHUNKS,
  ACP_MESSAGE_ENDS,
  acpChildSessionEnded,
  acpSessionUpdateFields
} from './acp-session-update-fields'

const PROMPT = 'session/prompt'

/** More messages than this in one cut replay can't be real; later ones read as started. */
const MAX_SEEN_MESSAGES = 1_024

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * ACP rows of streamed text are keyed by message id; a message has no start line, so the one a
 * cut replay starts inside is, per session, the first one it shows before a call, plan, user chunk,
 * subagent status or another message, and only that one continues under `<tag>:<message id>`. Messages without ids are
 * numbered within their turn, and a cut turn numbers them anew (`replayedWhole`).
 */
export class AcpRelayItemContinuation implements ProviderRelayItemContinuation {
  private readonly seen = new Set<string>()
  /** Sessions past their first message or a boundary: their later messages start whole. */
  private readonly started = new Set<string | undefined>()

  /** `childSessions`: the agent's subagents are child sessions (OpenCode) that report their end.
   *  `inherit`: given the cut messages that may still resume, at each attach. */
  constructor(
    private readonly childSessions = false,
    private readonly inherit?: (
      cuts: AcpInheritedCut[],
      overflow: boolean,
      savedThrough: number,
      openChildren: readonly string[]
    ) => void
  ) {}

  /** The messages this attach's cut split, as the client named them; null: unnamed, so guessed. */
  private cutKeys: ReadonlySet<string> | null = null
  /** What may still resume at this attach: the cut prompts' messages, and open children's. */
  private resumable: { prompt: boolean; children: ReadonlySet<string> } = {
    prompt: false,
    children: new Set()
  }

  /** The turn running across the attach (the agent's own, or an adopted prompt's) until it ends or
   *  a prompt is sent: a later prompt's messages are new, so none it streams was moved. */
  private agentTurnOpen = true

  /** A moved message may still resume: while the turn running at attach goes on. */
  mayResume(): boolean {
    return this.agentTurnOpen
  }

  /** The turn running at attach ended: its messages resume no more. */
  agentTurnEnded(): void {
    this.agentTurnOpen = false
  }

  /** Each attach's replay is read from its own first line. */
  reset(): void {
    this.agentTurnOpen = true
    this.seen.clear()
    this.started.clear()
    this.cutKeys = null
  }

  item(line: string): { key: string; start: boolean; end: boolean } | null {
    const update = acpSessionUpdateFields(line)
    const kind = update?.sessionUpdate
    if (!update || !kind) {
      return null
    }
    if (ACP_MESSAGE_ENDS.has(kind) || ACP_MESSAGE_BOUNDARIES.has(kind)) {
      this.started.add(update.sessionId)
      return null
    }
    if (!ACP_MESSAGE_CHUNKS.has(kind) || update.messageId === undefined) {
      return null
    }
    const key = JSON.stringify([update.sessionId, update.messageId])
    if (this.seen.has(key)) {
      return { key, start: false, end: false }
    }
    // Named by the cut, exactly those moved (all, past what a cut can name); else, as the floor cuts, a session's first message a
    // replay meets before a boundary.
    const start = this.cutKeys
      ? !this.cutKeys.has(key) && !this.cutKeys.has(RELAY_CUT_KEYS_OVERFLOW)
      : this.started.has(update.sessionId)
    const full = this.seen.size >= MAX_SEEN_MESSAGES
    if (!full) {
      this.seen.add(key)
      this.started.add(update.sessionId)
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

  /** The earlier app's prompts whose turn starts before the daemon's cut: the cursor may be inside
   *  one of their messages, so the continuation reads until each is answered. */
  openAt(result: ProviderRelayAttachResult): string[] | null {
    this.cutKeys = result.cutKeys ? new Set(result.cutKeys) : null
    const cut = (result.outstanding ?? []).filter(
      (request) => request.method === PROMPT && !request.replayedWhole
    )
    // OpenCode's subagents stream past their parent's prompt, until each reports its end.
    const children = this.childSessions ? (result.openWork?.subagent ?? []) : []
    this.resumable = { prompt: cut.length > 0, children: new Set(children.map((key) => key[0])) }
    const overflow = this.cutKeys?.has(RELAY_CUT_KEYS_OVERFLOW) === true
    this.inherit?.(this.stillCut(), overflow, result.savedThrough ?? 0, [
      ...this.resumable.children
    ])
    const open = [
      ...cut.map((request) => JSON.stringify(request.id)),
      ...children.map((key) => JSON.stringify(key))
    ]
    return open.length > 0 ? open : null
  }

  private stillCut(): AcpInheritedCut[] {
    return [...(this.cutKeys ?? [])].flatMap((key) => {
      const parts: unknown = key === RELAY_CUT_KEYS_OVERFLOW ? null : safeJson(key)
      const [session, id] = Array.isArray(parts) ? parts : []
      const child = typeof session === 'string' && this.resumable.children.has(session)
      return typeof session === 'string' && typeof id === 'string'
        ? [{ session, id, child, resumes: this.awaits(key) }]
        : []
    })
  }

  /** A named message resumes only inside a prompt still running, an agent-started turn not yet
   *  ended, or a child session still open. */
  awaits(key: string): boolean {
    let session: unknown
    try {
      const parts: unknown = JSON.parse(key)
      session = Array.isArray(parts) ? parts[0] : undefined
    } catch {
      // Keys are opaque to the daemon; one this app didn't write names no session.
    }
    return typeof session === 'string' && this.resumable.children.has(session)
      ? true
      : this.resumable.prompt || this.agentTurnOpen
  }

  settles(line: string): string | null {
    const id = jsonRpcAnswerId(line)
    const child = id === null ? acpChildSessionEnded(line) : null
    return id !== null ? JSON.stringify(id) : child !== null ? JSON.stringify([child]) : null
  }

  /** The moved chunk itself opens the continuation for the floor. */
  start(line: string, tag: string): string {
    return this.rekey(line, tag)
  }
}
