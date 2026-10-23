import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import {
  findLink,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import { bindPane, deliverFollowUp, type FollowUpTerminal } from './external-conversation-send'
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

/** What the seam drives on its host: the launch path, and the linked terminals and their reopen. */
export type ExternalConversationHost = {
  launcher: ConversationLauncher
  terminal: ConversationTerminal
}

export type ConversationTerminal = FollowUpTerminal & ReopenTerminal

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime), terminal: runtime }
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  readSettings: () => AgentStatusHooksSettings
  /** Outlives the seam: a re-enable must not take this process's running deliveries for leftovers. */
  receipts: DeliveryReceipts
  /** Worktree removals; returns the release. */
  onWorkspaceRemoved: (listener: (worktreeId: string) => void) => () => void
  /** The hook rows linked agents' sessions are read from. */
  sessionRows: SessionRows
  /** The hook store's provider sessions by pane, on every change; returns the release. */
  onProviderSessionsChanged: (
    listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
  ) => () => void
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/**
 * The connector seam for one enabled period. Turning connectors off disposes it: queued work
 * settles `connectors_disabled` at once and running work stops at its next boundary. Turning them
 * on builds a fresh one.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly chain = new ConversationChain(this.abort.signal)
  /** Conversations this period started, so a second start for one shares its creation. */
  private readonly startedHere = new Set<string>()
  /** Conversations with work sent here, by the workspace their link was on. */
  private readonly linked = new Map<string, { key: ConversationKey; worktreeId: string }>()
  /**
   * The process each lane admitted first, by a launch or a send; its queued work goes there or
   * nowhere. Null: a launch published no process this lane can prove, so queued work goes nowhere.
   */
  private readonly admitted = new WeakMap<AbortSignal, AgentPromptExpectedBinding | null>()
  private readonly sessions: LinkedSessionCapture
  private readonly releaseRemovals: () => void
  private readonly releaseSessions: () => void

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.sessions = new LinkedSessionCapture(deps.store, deps.sessionRows)
    // A removed workspace may keep its PTY registered a while; its held and queued sends end now.
    // The event names no host, so a same-path twin's removal is told apart by the link surviving.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
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
    // Subscribed first, so a session reported while the snapshot is read is not missed.
    this.sessions.restore()
  }

  /** Deferred work passes this to every effect, so nothing starts or writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.releaseSessions()
    this.abort.abort(reason)
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
            // A link from before this period cannot say what became of its launch.
            return this.startedHere.has(conversationId(key))
              ? this.deliver(host.terminal, key, linked, deliveryId, input.prompt, signal)
              : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          return launchConversation(
            host.launcher,
            { ...input, agent },
            signal,
            (workspace, paneKey) => {
              writeLink(this.deps.store, workspace, {
                ...key,
                paneKey,
                agent,
                createdAt: Date.now()
              })
              this.startedHere.add(conversationId(key))
              this.sessions.capture(key, paneKey)
            },
            // Before link resolution or prompt delivery settle, so no follower adopts a successor.
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
    // A lane that already reached a process may only ever write to that one.
    const laneAdmitted = this.admitted.has(signal)
    const admitted = laneAdmitted ? this.admitted.get(signal) : pane?.binding
    if (pane && admitted && sameBinding(pane.binding, admitted)) {
      this.admitted.set(signal, admitted)
      const delivery = await this.write(terminal, key, linked.link, pane, deliveryId, text, signal)
      if (delivery.outcome !== 'refused' || delivery.reason !== 'agent_not_reachable') {
        return delivery
      }
    }
    // The admitted process is gone or replaced: queued work must not reach its successor.
    return laneAdmitted
      ? this.lost(id, signal)
      : this.reopen(terminal, key, linked, deliveryId, text, signal)
  }

  /**
   * The lane's first write found no agent: the lifecycle's safe resume reopens the conversation in
   * its workspace, or refuses while the old pane may still hold it (an SSH host out of contact
   * included). The reopened process becomes the lane's, so work queued behind follows it.
   */
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

  /** Settles this conversation's queue before it advances; a later send opens a new lane. */
  private lost(
    id: string,
    laneSignal: AbortSignal,
    reason: ConnectorRefusal = 'agent_not_reachable'
  ): Delivery {
    this.chain.cancel(id, reason, laneSignal)
    return refused(reason)
  }
}

function sameBinding(a: AgentPromptExpectedBinding, b: AgentPromptExpectedBinding): boolean {
  return a.ptyId === b.ptyId && a.processIncarnation === b.processIncarnation
}
