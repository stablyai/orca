import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../shared/agent-transitions'
import type { AgentTurnOutcome } from '../../shared/agent-turn-outcome'
import type {
  ConnectorAgent,
  ExternalConversationLink
} from '../../shared/external-conversation-link'
import { judgeIdleAgentTurn } from '../agent-turn-idle-verdict'
import {
  TerminalAgentTurnNews,
  type TerminalAgentTurnNewsItem
} from '../runtime/terminal-agent-turn-news'
import {
  allLinks,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import { sameBinding } from './external-conversation-send'
import { workingStampedTurn } from './external-conversation-turn-id'
import type { ConversationKey } from './external-conversation-types'

type ConversationPane = { conversation: ConversationKey; worktreeId: string; paneKey: string }

export type ConversationEvent =
  | (ConversationPane & { kind: 'linked'; agent: ConnectorAgent })
  | (ConversationPane & { kind: 'prompt'; prompt: PendingPrompt })
  | (ConversationPane & { kind: 'turn-started'; at: number })
  | (ConversationPane & {
      kind: 'turn-ended'
      /** The ended turn's turn-started `at`; null when its start predates this watch and the row kept none. */
      turnId: number | null
      /** Host verdict; null means none was recorded. */
      stopReason: AgentTurnOutcome | null
      lastAssistantMessage?: string
      at: number
    })

export type ConversationSnapshot = {
  kind: 'snapshot'
  conversations: (ConversationPane & {
    agent: ConnectorAgent
    working: boolean
    prompt: PendingPrompt | null
    /** The pane's latest turn, as its turn events name it; null before any. */
    turnId: number | null
    /** When the conversation last showed activity: its link, or its agent's latest hook report. */
    activeAt: number
  })[]
}

export type ConversationWatchListener = (event: ConversationSnapshot | ConversationEvent) => void

export type ConversationEventsDeps = {
  store: ExternalConversationLinkStore
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  readBinding: (paneKey: string) => AgentPromptExpectedBinding | null
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
  pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

// Pending finishes must not keep the process alive.
export const HOST_CLOCK: Pick<ConversationEventsDeps, 'setTimer' | 'now'> = {
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  },
  now: Date.now
}

/** Watch-scoped turn news shares mobile push detection and automation completion verdicts. */
export class ConversationEvents {
  private readonly listeners = new Set<ConversationWatchListener>()
  // A started turn's id only where the host stamps none; the host's stamp is the id everywhere else.
  private readonly unstampedTurn = new Map<string, number>()
  // The stamped turn last announced per pane, only so a start is told once; never read as an id.
  private readonly announcedTurn = new Map<string, number>()
  // Prompts our cancel rejected, by pane: Claude's hooks report no end for that turn.
  private readonly rejected = new Map<
    string,
    { row: AgentStatusIpcPayload; binding: AgentPromptExpectedBinding; at: number }
  >()
  private release: (() => void) | null = null

  constructor(private readonly deps: ConversationEventsDeps) {}

  watch(listener: ConversationWatchListener): () => void {
    if (!this.release) {
      const news = new TerminalAgentTurnNews<TerminalAgentTurnNewsItem>({
        readHookRow: (paneKey) => this.deps.readHookRow(paneKey),
        prepare: (item) => item,
        deliver: (item) => this.told(item),
        setTimer: (run, delayMs) => this.deps.setTimer(run, delayMs),
        started: (item) => this.started(item),
        stopped: (item) => this.ended(item, agentMainAgentVerdict(item.row))
      })
      const unsubscribe = this.deps.onAgentPaneChange((change) => {
        this.settleRejected(change.paneKey)
        news.observe(change)
        // A working row's stamp is told once, whether or not news reported its start.
        const stamp = workingStampedTurn(this.deps.readHookRow(change.paneKey))
        if (stamp !== null && change.workspace) {
          this.announceStamp(change.paneKey, change.workspace.worktreeId, stamp)
        }
      })
      this.release = () => {
        unsubscribe()
        news.dispose()
      }
    }
    this.listeners.add(listener)
    // Subscribe before reading the snapshot to avoid losing intervening changes.
    listener(this.snapshot())
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.dispose()
      }
    }
  }

  linked({ workspace, link }: LinkedConversation): void {
    this.emit({
      kind: 'linked',
      ...pane(link, workspace.worktreeId),
      agent: link.agent
    })
  }

  rejectedByCancel(
    paneKey: string,
    row: AgentStatusIpcPayload,
    binding: AgentPromptExpectedBinding,
    at: number
  ): void {
    if (!this.release || row.agentType !== 'claude' || row.programStatus?.state !== 'blocked') {
      return
    }
    this.rejected.set(paneKey, { row, binding, at })
    // The idle observation can arrive before the write acknowledgment.
    this.settleRejected(paneKey)
  }

  forgetUnlinked(): void {
    for (const paneKey of this.rejected.keys()) {
      if (!this.linkedFor(paneKey)) {
        this.rejected.delete(paneKey)
      }
    }
  }

  dispose(): void {
    this.release?.()
    this.release = null
    this.listeners.clear()
    this.unstampedTurn.clear()
    this.announcedTurn.clear()
    this.rejected.clear()
  }

  /**
   * The rejected turn ended when Claude's own activity report goes idle while the host still shows
   * that prompt; once the host's row moves on, its own news tells the turn.
   */
  private settleRejected(paneKey: string): void {
    const rejected = this.rejected.get(paneKey)
    if (!rejected) {
      return
    }
    const row = this.deps.readHookRow(paneKey)
    const linked = this.linkedFor(paneKey)
    const binding = this.deps.readBinding(paneKey)
    if (
      !row ||
      !linked ||
      linked.link.agent !== 'claude' ||
      !binding ||
      !sameBinding(binding, rejected.binding) ||
      row.agentType !== rejected.row.agentType ||
      row.state !== rejected.row.state ||
      row.stateStartedAt !== rejected.row.stateStartedAt ||
      row.interactivePrompt !== rejected.row.interactivePrompt ||
      row.toolName !== rejected.row.toolName
    ) {
      this.rejected.delete(paneKey)
      return
    }
    const activity = row.programStatus
    if (
      activity?.state !== 'idle' ||
      activity.observedAt < rejected.at ||
      activity.observedAt <= (rejected.row.programStatus?.observedAt ?? 0)
    ) {
      return
    }
    this.rejected.delete(paneKey)
    this.emit({
      kind: 'turn-ended',
      ...pane(linked.link, linked.workspace.worktreeId),
      turnId: this.takeTurnId(paneKey, row),
      stopReason: 'cancellation',
      at: activity.observedAt
    })
  }

  private snapshot(): ConversationSnapshot {
    return {
      kind: 'snapshot',
      conversations: [...allLinks(this.deps.store)].map(({ workspace, link }) => {
        const row = this.deps.readHookRow(link.paneKey)
        const working = row ? hookRowAgentPhase(row) === 'working' : false
        return {
          ...pane(link, workspace.worktreeId),
          agent: link.agent,
          working,
          prompt: this.deps.pendingPrompt(link),
          // Unstamped and unseen: the working phase's start, as before stamps.
          turnId: this.turnIdOf(link.paneKey, row) ?? (row && working ? row.stateStartedAt : null),
          activeAt: Math.max(link.createdAt, row?.receivedAt ?? 0)
        }
      })
    }
  }

  private started(item: TerminalAgentTurnNewsItem): void {
    const link = this.linkedFor(item.paneKey)?.link
    if (!link) {
      return
    }
    if (item.row.turnStartedAt !== undefined) {
      this.announceStamp(item.paneKey, item.worktreeId, item.row.turnStartedAt)
      return
    }
    this.unstampedTurn.set(item.paneKey, item.row.stateStartedAt)
    this.emit({ kind: 'turn-started', ...pane(link, item.worktreeId), at: item.row.stateStartedAt })
  }

  /** Told once per stamp; the cloud applies a start only if it is newer than its own anyway. */
  private announceStamp(paneKey: string, worktreeId: string, at: number): void {
    const link = this.linkedFor(paneKey)?.link
    if (!link || this.announcedTurn.get(paneKey) === at) {
      return
    }
    this.announcedTurn.set(paneKey, at)
    // The host stamps this pane, so a start recorded before its first stamp names nothing.
    this.unstampedTurn.delete(paneKey)
    this.emit({ kind: 'turn-started', ...pane(link, worktreeId), at })
  }

  private told(item: TerminalAgentTurnNewsItem): void {
    const link = this.linkedFor(item.paneKey)?.link
    if (!link) {
      return
    }
    if (hookRowAgentPhase(item.row) === 'needs-you') {
      const prompt = this.deps.pendingPrompt(link)
      if (prompt) {
        this.emit({ kind: 'prompt', ...pane(link, item.worktreeId), prompt })
      }
      return
    }
    // Only done signals since this turn began count; reused panes can retain earlier verdicts.
    const verdict = judgeIdleAgentTurn(
      {
        rows: [item.row],
        sentAt: this.turnIdOf(item.paneKey, item.row) ?? 0,
        tail: [],
        readAgentCommands: () => []
      },
      this.deps.now()
    )
    if (verdict.kind === 'completed') {
      this.ended(item, agentMainAgentVerdict(item.row))
    }
  }

  private ended(item: TerminalAgentTurnNewsItem, stopReason: AgentTurnOutcome | null): void {
    const link = this.linkedFor(item.paneKey)?.link
    if (!link) {
      return
    }
    const message = item.row.lastAssistantMessage
    this.emit({
      kind: 'turn-ended',
      ...pane(link, item.worktreeId),
      turnId: this.takeTurnId(item.paneKey, item.row),
      stopReason,
      ...(message ? { lastAssistantMessage: message } : {}),
      at: item.row.stateStartedAt
    })
  }

  /** Where this pane's agent replies: its conversation and the turn it is in, as turn events name it. */
  replyTarget(paneKey: string): { key: ConversationKey; turnId: number | null } | null {
    const link = this.linkedFor(paneKey)?.link
    if (!link) {
      return null
    }
    const turnId = this.turnIdOf(paneKey, this.deps.readHookRow(paneKey))
    return { key: { source: link.source, externalId: link.externalId }, turnId }
  }

  /** The turn a pane is in: the host's stamp, else the unstamped start news reported. */
  private turnIdOf(paneKey: string, row: AgentStatusIpcPayload | null): number | null {
    return row?.turnStartedAt ?? this.unstampedTurn.get(paneKey) ?? null
  }

  /** An ending turn's id; an unstamped one's start is forgotten with it, as before. */
  private takeTurnId(paneKey: string, row: AgentStatusIpcPayload): number | null {
    const turnId = this.turnIdOf(paneKey, row)
    this.unstampedTurn.delete(paneKey)
    return turnId
  }

  private linkedFor(paneKey: string): LinkedConversation | null {
    for (const linked of allLinks(this.deps.store)) {
      if (linked.link.paneKey === paneKey) {
        return linked
      }
    }
    return null
  }

  private emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      // Isolate listener failures so other watchers still receive the event.
      try {
        listener(event)
      } catch (error) {
        console.error('[connector] watch listener threw', error)
      }
    }
  }
}

function pane(link: ExternalConversationLink, worktreeId: string): ConversationPane {
  return {
    conversation: { source: link.source, externalId: link.externalId },
    worktreeId,
    paneKey: link.paneKey
  }
}
