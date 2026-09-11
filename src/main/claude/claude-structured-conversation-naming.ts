// Ask Claude to name its own conversation, once per session.
//
// The name's home is the provider, not Orca: given `persist: true` the CLI appends an `ai-title`
// record to its own transcript, and the AI Vault scanner already reads that record to title the
// tab. Orca asks, the CLI persists, the vault reads — nothing here publishes a title.

import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { claudeDispatchTypedText } from './claude-structured-dispatch-content'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

type ClaudeNamedDispatchInput = {
  sessionId: string
  clientMessageId: string
  body: AgentJournalMessageItem
}

/** Close is requested before the connection reports itself closed, so both are read. */
function claudeSessionClosing(session: ClaudeSession): boolean {
  return session.connection.closed || session.closeFinalization !== undefined
}

export class ClaudeConversationNaming {
  /** Keyed by the session object rather than its id, so a later acquisition of the same
   *  conversation may ask again: one control request on an open connection is cheap. */
  private readonly attempted = new WeakSet<ClaudeSession>()
  private readonly pending = new Set<Promise<void>>()

  /** Dispatch a turn, then name the conversation on the first accepted one. Naming runs off the
   *  send path: it can neither delay nor fail the turn it followed. */
  dispatchTurn(
    deps: ClaudeStructuredSessionAdapterDeps,
    session: ClaudeSession,
    input: ClaudeNamedDispatchInput
  ): Promise<AgentSessionDispatchOutcome> {
    return dispatchClaudeTurn(session, input).then((outcome) => {
      // Both states mean the provider took the message; `admitted` just settles its identity
      // later, and naming needs the turn to exist, not its identity. `accepted` is the recovery
      // path where the write threw after the replay had already settled — a delivered turn.
      if (outcome.state === 'accepted' || outcome.state === 'admitted') {
        this.start(deps, session, input)
      }
      return outcome
    })
  }

  /** Resolves once every naming attempt started so far has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      // Iterated synchronously by `Promise.all`, so a settling attempt cannot drop out of it.
      await Promise.all(this.pending)
    }
  }

  private start(
    deps: ClaudeStructuredSessionAdapterDeps,
    session: ClaudeSession,
    input: ClaudeNamedDispatchInput
  ): void {
    const attempt = this.name(deps, session, input)
      .catch((error: unknown) => {
        console.warn('[claude-structured] conversation naming failed', error)
      })
      .finally(() => {
        this.pending.delete(attempt)
      })
    this.pending.add(attempt)
  }

  private async name(
    deps: ClaudeStructuredSessionAdapterDeps,
    session: ClaudeSession,
    input: ClaudeNamedDispatchInput
  ): Promise<void> {
    const store = deps.storeConversationName
    if (
      !store ||
      claudeSessionClosing(session) ||
      this.attempted.has(session) ||
      // A name on the record means an earlier session already asked; asking again re-charges
      // the user for a title they have.
      deps.readConversationName?.(input.sessionId)
    ) {
      return
    }
    const description = claudeDispatchTypedText(input.body).trim()
    if (!description) {
      return
    }
    this.attempted.add(session)
    const title = await session.connection.generateSessionTitle(description, {
      // What makes the CLI write the name into its own transcript; the whole design rests on it.
      persist: true,
      ...(deps.requestTimeoutMs === undefined ? {} : { timeoutMs: deps.requestTimeoutMs })
    })
    if (title.outcome !== 'named') {
      return
    }
    const name = normalizeAgentSessionConversationName(title.title)
    if (name) {
      // Orca's memory that it named this session, not a display source: the tab title comes from
      // the CLI's transcript record, which `persist: true` above wrote.
      await store(input.sessionId, name)
    }
  }
}
