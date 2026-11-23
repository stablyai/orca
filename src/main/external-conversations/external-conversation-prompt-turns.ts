import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type {
  ConnectorPrompt,
  ConnectorPromptAudience
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConversationEvent } from './external-conversation-events'
import type { LinkedConversation } from './external-conversation-links'
import { conversationPane } from './external-conversation-types'
import { promptAudience } from './external-conversation-prompt-audience'

export class PromptTurns {
  // Bot chats whose current turn, which their conversation didn't ask for, it was shown to see its
  // prompt: it hears that turn's state, never its words.
  readonly adopted = new Set<string>()
  // Who raised each chat's shown prompt, read once per prompt and conversation.
  private readonly audiences = new Map<
    string,
    { promptId: string; externalId: string; audience: ConnectorPromptAudience }
  >()

  constructor(
    private readonly deps: {
      promptsAudience: () => boolean
      turnOpener: (sessionId: string) => AgentJournalRenderItem | null
      pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
      keepAdoptedTurn: (
        linked: LinkedConversation,
        turn: ExternalConversationLink['adoptedTurn']
      ) => void
      turnOf: (paneKey: string) => number | null
      hears: (link: ExternalConversationLink) => boolean
      runningTurnWoken: (sessionId: string) => boolean
      remember: (paneKey: string, at: number) => void
      emit: (event: ConversationEvent) => void
    }
  ) {}

  /** A bot's conversation is shown its chat's prompts whoever began the turn, but only to a cloud
   *  that routes them by who raised them; any other cloud hears none of that turn. */
  private showsUnheard(link: ExternalConversationLink): boolean {
    return Boolean(link.bot) && this.deps.promptsAudience()
  }

  adoptedTurn(link: ExternalConversationLink): boolean {
    if (this.adopted.has(link.paneKey)) {
      return true
    }
    // A watch begun since (a restart, a new hello) adopts the running turn the link kept, so its
    // end still tells no words, though its prompt was answered meanwhile.
    if (
      link.adoptedTurn &&
      this.deps.turnOpener(link.sessionId)?.itemId === link.adoptedTurn.itemId
    ) {
      this.adopted.add(link.paneKey)
      this.deps.remember(link.paneKey, link.adoptedTurn.at)
      return true
    }
    return false
  }

  /**
   * The prompt the conversation is shown, if any. A bot's conversation that didn't ask for the turn
   * first adopts it: it is told the turn began (when `tellStart`), with no delivery, and later that it
   * ended, with no message.
   */
  shownPrompt(linked: LinkedConversation, tellStart: boolean): ConnectorPrompt | null {
    const { link } = linked
    const heard = this.deps.hears(link)
    if (!heard && !this.showsUnheard(link)) {
      return null
    }
    const prompt = this.deps.pendingPrompt(link)
    if (!prompt) {
      return null
    }
    const audience = link.bot ? this.audienceOf(link, prompt) : undefined
    if (audience?.raisedBy === 'orca' && !this.deps.promptsAudience()) {
      return null
    }
    if (!heard || (audience?.raisedBy === 'orca' && !this.adoptedTurn(link))) {
      this.adoptFor(linked, tellStart && !heard)
    }
    return audience ? { ...prompt, ...audience } : prompt
  }

  private adoptFor(linked: LinkedConversation, tellStart: boolean): void {
    const { link } = linked
    const at = this.deps.turnOf(link.paneKey)
    this.adopted.add(link.paneKey)
    const opener = this.deps.turnOpener(link.sessionId)
    if (opener && at !== null) {
      this.deps.keepAdoptedTurn(linked, { itemId: opener.itemId, at })
    }
    if (at === null) {
      return
    }
    this.deps.remember(link.paneKey, at)
    if (tellStart) {
      this.deps.emit({
        kind: 'turn-started',
        ...conversationPane(link, linked.workspace.worktreeId),
        at
      })
    }
  }

  private audienceOf(
    link: ExternalConversationLink,
    prompt: PendingPrompt
  ): ConnectorPromptAudience {
    const known = this.audiences.get(link.paneKey)
    if (known?.promptId === prompt.promptId && known.externalId === link.externalId) {
      return known.audience
    }
    const opener = this.deps.turnOpener(link.sessionId)
    const woke = this.deps.runningTurnWoken(link.sessionId)
    const audience = promptAudience(link, prompt, opener, woke)
    this.audiences.set(link.paneKey, {
      promptId: prompt.promptId,
      externalId: link.externalId,
      audience
    })
    return audience
  }

  clear(): void {
    this.adopted.clear()
    this.audiences.clear()
  }
}
