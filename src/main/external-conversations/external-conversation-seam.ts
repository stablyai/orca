import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { cancelConversation, type CancelTerminal } from './external-conversation-cancel'
import { ConversationChain } from './external-conversation-chain'
import {
  ConversationEvents,
  HOST_CLOCK,
  type ConversationWatchListener
} from './external-conversation-events'
import { ConversationPrompts } from './external-conversation-prompts'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import {
  findLink,
  requireLink,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import {
  bindPane,
  deliverFollowUp,
  sameBinding,
  type FollowUpTerminal
} from './external-conversation-send'
import { reopenLinkedAgent, type ReopenTerminal } from './external-conversation-reopen'
import { LinkedSessionCapture, type SessionRows } from './external-conversation-session-capture'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import {
  launchConversation,
  runtimeConversationLauncher,
  type ConversationLaunchInput,
  type ConversationLauncher
} from './external-conversation-start'
import {
  conversationId,
  refused,
  type ConnectorRefusal,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

export type ExternalConversationHost = {
  launcher: ConversationLauncher
  terminal: ConversationTerminal
}

export type ConversationTerminal = FollowUpTerminal & ReopenTerminal & CancelTerminal

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime), terminal: runtime }
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  readSettings: () => AgentStatusHooksSettings
  /** Re-enabling must not settle this process's running deliveries as abandoned leftovers. */
  receipts: DeliveryReceipts
  onWorkspaceRemoved: (listener: (worktreeId: string) => void) => () => void
  sessionRows: SessionRows
  onProviderSessionsChanged: (
    listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
  ) => () => void
  /** The hook store's newest row for a pane. */
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  /** The transition detector's pane changes; returns the release. */
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/** One enabled period: disabling settles queued work and aborts running work at its next boundary. */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly chain = new ConversationChain(this.abort.signal)
  // Only starts from this enabled period can prove their launch outcome.
  private readonly startedHere = new Set<string>()
  private readonly linked = new Map<string, { key: ConversationKey; worktreeId: string }>()
  // Bind each lane to its first admitted process; null means no published process could be proven.
  private readonly admitted = new WeakMap<AbortSignal, AgentPromptExpectedBinding | null>()
  private readonly sessions: LinkedSessionCapture
  private readonly prompts: ConversationPrompts
  /** Built by the first watcher, so an unwatched seam subscribes to nothing. */
  private events: ConversationEvents | null = null
  private readonly releaseRemovals: () => void
  private readonly releaseSessions: () => void

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.sessions = new LinkedSessionCapture(deps.store, deps.sessionRows)
    this.prompts = new ConversationPrompts(deps.readSettings, deps.readHookRow)
    // Cancel removed-workspace lanes; surviving links distinguish same-path twins on other hosts.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
      this.events?.forgetUnlinked()
      for (const [id, { key, worktreeId: linkedTo }] of this.linked) {
        if (linkedTo === worktreeId && !findLink(this.deps.store, key)) {
          this.linked.delete(id)
          this.chain.cancel(id, 'agent_not_reachable')
        }
      }
    })
    this.releaseSessions = deps.onProviderSessionsChanged((sessions) =>
      this.sessions.sessionsChanged(sessions)
    )
    // Subscribe before snapshotting so sessions reported during restore cannot be missed.
    this.sessions.restore()
  }

  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.releaseSessions()
    this.events?.dispose()
    this.abort.abort(reason)
  }

  pendingPrompt(host: ExternalConversationHost, key: ConversationKey): PendingPrompt | null {
    return this.prompts.pending(host.terminal, requireLink(this.deps.store, key).link)
  }

  answer(
    host: ExternalConversationHost,
    key: ConversationKey,
    promptId: string,
    optionId: string
  ): Promise<Delivery> {
    if (this.abort.signal.aborted) {
      return Promise.resolve(refused('connectors_disabled'))
    }
    return this.prompts.answer(host.terminal, requireLink(this.deps.store, key).link, {
      promptId,
      optionId,
      signal: this.abort.signal
    })
  }

  /** Receipted like a send, so a retried delivery never cancels twice. */
  cancel(host: ExternalConversationHost, key: ConversationKey, id: string): Promise<Delivery> {
    const { prompts, chain, events } = this
    const seam = { ...this.deps, prompts, chain, events }
    return this.deps.receipts.run(key, id, 'connector.cancel', [], () =>
      cancelConversation(host.terminal, seam, key, this.abort.signal)
    )
  }

  /** A snapshot of every linked conversation first, then its events; returns the release. */
  watch(host: ExternalConversationHost, listener: ConversationWatchListener): () => void {
    if (this.abort.signal.aborted) {
      throw new Error('connectors_disabled')
    }
    this.events ??= new ConversationEvents({
      store: this.deps.store,
      readHookRow: this.deps.readHookRow,
      readBinding: (paneKey) => bindPane(host.terminal, paneKey)?.binding ?? null,
      onAgentPaneChange: this.deps.onAgentPaneChange,
      pendingPrompt: (link) => this.prompts.pending(host.terminal, link),
      ...HOST_CLOCK
    })
    return this.events.watch(listener)
  }

  async start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: StartInput
  ): Promise<ConversationStart> {
    const initial = await this.deps.receipts.run(
      key,
      deliveryId,
      'connector.start',
      [input.agent, input.target, input.prompt],
      () =>
        this.chain.enqueue(conversationId(key), async (signal) => {
          const { agent } = input
          if (!admitConnectorAgent(this.deps.readSettings(), agent)) {
            return refused('unsupported_agent')
          }
          const linked = findLink(this.deps.store, key)
          if (linked) {
            // A prior enabled period's link cannot prove the launch outcome.
            return this.startedHere.has(conversationId(key))
              ? this.deliver(host.terminal, key, linked, deliveryId, input.prompt, signal)
              : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          return launchConversation(
            host.launcher,
            { ...input, agent },
            signal,
            (workspace, paneKey) => {
              const link = { ...key, paneKey, agent, createdAt: Date.now() }
              writeLink(this.deps.store, workspace, link)
              this.events?.linked({ workspace, link })
              this.startedHere.add(conversationId(key))
              this.sessions.capture(key, paneKey)
            },
            // Capture publication before followers run so they cannot adopt a successor process.
            (paneKey) => {
              this.admitted.set(
                signal,
                (paneKey && bindPane(host.terminal, paneKey)?.binding) || null
              )
            }
          )
        })
    )
    return { conversation: key, initial }
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    text: string
  ): Promise<Delivery> {
    const id = conversationId(key)
    return this.deps.receipts.run(key, deliveryId, 'connector.send', [text], () => {
      const queued = findLink(this.deps.store, key)
      if (queued) {
        this.linked.set(id, { key, worktreeId: queued.workspace.worktreeId })
      }
      return this.chain.enqueue(id, async (signal) => {
        const linked = findLink(this.deps.store, key)
        if (!linked) {
          throw new Error('external_conversation_not_found')
        }
        return this.deliver(host.terminal, key, linked, deliveryId, text, signal)
      })
    })
  }

  private async deliver(
    terminal: ConversationTerminal,
    key: ConversationKey,
    found: LinkedConversation,
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    const id = conversationId(key)
    const linked = this.sessions.capture(key, found.link.paneKey) ?? found
    this.linked.set(id, { key, worktreeId: linked.workspace.worktreeId })
    const pane = bindPane(terminal, linked.link.paneKey)
    // Once a lane admits a process, queued writes must never reach a replacement.
    const laneAdmitted = this.admitted.has(signal)
    const admitted = laneAdmitted ? this.admitted.get(signal) : pane?.binding
    if (pane && admitted && sameBinding(pane.binding, admitted)) {
      this.admitted.set(signal, admitted)
      const delivery = await this.write(terminal, key, linked.link, pane, deliveryId, text, signal)
      if (delivery.outcome !== 'refused' || delivery.reason !== 'agent_not_reachable') {
        return delivery
      }
    }
    return laneAdmitted
      ? this.lost(id, signal)
      : this.reopen(terminal, key, linked, deliveryId, text, signal)
  }

  /** A lane with no admitted process may safely resume the linked session; queued work then binds to that process. */
  private async reopen(
    terminal: ConversationTerminal,
    key: ConversationKey,
    { workspace, link }: LinkedConversation,
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    const id = conversationId(key)
    const relinked = { ...link }
    const reopened = await reopenLinkedAgent(
      terminal,
      workspace.worktreeId,
      link,
      JSON.stringify(['connector-reopen', key.source, key.externalId, deliveryId]),
      signal,
      (paneKey) => {
        relinked.paneKey = paneKey
        writeLink(this.deps.store, workspace, relinked)
        this.events?.linked({ workspace, link: relinked })
        this.sessions.capture(key, paneKey)
      }
    )
    if (!reopened.ok) {
      return this.lost(id, signal, reopened.refusal)
    }
    const { pane } = reopened
    this.admitted.set(signal, pane.binding)
    const delivery = await this.write(terminal, key, relinked, pane, deliveryId, text, signal)
    if (delivery.outcome === 'accepted') {
      return { outcome: 'accepted', reopened: true }
    }
    return delivery.outcome === 'refused' && delivery.reason === 'agent_not_reachable'
      ? this.lost(id, signal)
      : delivery
  }

  private write(
    terminal: ConversationTerminal,
    key: ConversationKey,
    link: ExternalConversationLink,
    pane: { handle: string; binding: AgentPromptExpectedBinding },
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    return deliverFollowUp(terminal, {
      handle: pane.handle,
      expectedBinding: pane.binding,
      agent: link.agent,
      text,
      requestId: JSON.stringify([key.source, key.externalId, deliveryId]),
      signal
    })
  }

  /** Cancel the queue before advancing; later sends create a fresh lane. */
  private lost(
    id: string,
    laneSignal: AbortSignal,
    reason: ConnectorRefusal = 'agent_not_reachable'
  ): Delivery {
    this.chain.cancel(id, reason, laneSignal)
    return refused(reason)
  }
}
