import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { claudeAgentViewChord } from './agent-view-keybindings'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  type ClaudeAgentViewObservation,
  type ClaudeAgentViewSnapshot,
  type ClaudeAgentViewResult
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'
import {
  Message,
  type BridgeReply,
  type PendingView,
  type ViewSession
} from './agent-view-bridge-protocol'

const SESSION_TTL_MS = 150_000
// Expire sessions whose deadlines fall close together in one pass and one publish.
const EXPIRY_BATCH_MS = 5_000

export class ClaudeAgentViewBridge {
  private readonly sessions = new Map<string, ViewSession>()
  private readonly listeners = new Set<(snapshot: ClaudeAgentViewSnapshot) => void>()
  private expiryTimer?: ReturnType<typeof setTimeout>
  private publishedSnapshot: ClaudeAgentViewSnapshot = []

  subscribe(listener: (snapshot: ClaudeAgentViewSnapshot) => void): () => void {
    this.prune()
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => void this.listeners.delete(listener)
  }

  private snapshot(): ClaudeAgentViewSnapshot {
    return [...this.sessions.values()]
      .filter((session) => session.view)
      .map((session) => ({
        paneKey: session.paneKey,
        sessionId: session.sessionId,
        ...(session.view?.agentId ? { agentId: session.view.agentId } : {})
      }))
  }

  private publish(): void {
    const snapshot = this.snapshot()
    const previous = this.publishedSnapshot
    if (
      snapshot.length === previous.length &&
      snapshot.every(
        (entry, index) =>
          entry.paneKey === previous[index].paneKey &&
          entry.sessionId === previous[index].sessionId &&
          entry.agentId === previous[index].agentId
      )
    ) {
      return
    }
    this.publishedSnapshot = snapshot
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  /** Returns whether the published snapshot can change. */
  private observe(session: ViewSession, view: z.infer<typeof ClaudeAgentViewObservation>): boolean {
    if (session.view && session.view.revision >= view.revision) {
      return false
    }
    const changed = !session.view || session.view.agentId !== view.agentId
    session.view = view
    return changed
  }

  receive(body: unknown): BridgeReply {
    const parsed = Message.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    const current = this.sessions.get(message.paneKey)
    if (message.action === 'register') {
      const chord =
        current?.keybindings === message.keybindings
          ? current.chord
          : claudeAgentViewChord(message.keybindings)
      if (!chord) {
        if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
          current.pending?.finish({ status: 'unavailable' })
          this.sessions.delete(message.paneKey)
          this.armExpiry()
          this.publish()
        }
        return { renew: true }
      }
      if (!current && this.sessions.size >= 1024) {
        return {}
      }
      const known =
        current?.instanceId === message.instanceId && current.sessionId === message.sessionId
      if (known) {
        current.seenAt = Date.now()
        current.chord = chord
        current.keybindings = message.keybindings
      } else {
        current?.pending?.finish({ status: 'unavailable' })
        this.sessions.set(message.paneKey, {
          paneKey: message.paneKey,
          sessionId: message.sessionId,
          instanceId: message.instanceId,
          chord,
          keybindings: message.keybindings,
          seenAt: Date.now()
        })
      }
      const session = this.sessions.get(message.paneKey)
      const viewChanged = session && message.view ? this.observe(session, message.view) : false
      this.armExpiry()
      if (!known || viewChanged) {
        this.publish()
      }
      return { registered: true, renew: true }
    }
    if (
      !current ||
      current.instanceId !== message.instanceId ||
      current.sessionId !== message.sessionId
    ) {
      return {}
    }
    if (message.action === 'renew') {
      current.seenAt = Date.now()
      this.armExpiry()
      // Carrying the view repairs a lost observe without a full registration.
      if (message.view && this.observe(current, message.view)) {
        this.publish()
      }
      return { registered: true }
    }
    if (message.action === 'end') {
      current.pending?.finish({ status: 'unavailable' })
      this.sessions.delete(message.paneKey)
      this.armExpiry()
      this.publish()
      return {}
    }
    if (message.action === 'observe') {
      if (this.observe(current, message.view)) {
        this.publish()
      }
      return {}
    }
    const request = current.pending
    if (!request) {
      return {}
    }
    if (message.action === 'take') {
      if (request.taken || request.expiresAt < Date.now()) {
        return {}
      }
      request.taken = true
      return {
        requestId: request.requestId,
        agentId: request.agentId,
        expiresAt: request.expiresAt
      }
    }
    if (request.taken && message.requestId === request.requestId) {
      request.finish(
        message.deny ? { status: 'denied', reason: message.deny } : { status: 'viewed' }
      )
    }
    return {}
  }

  async view(args: {
    paneKey: string
    sessionId: string
    agentId?: string
    trigger: (input: string, isCurrent: () => boolean) => Promise<boolean>
    signal?: AbortSignal
  }): Promise<ClaudeAgentViewResult> {
    this.prune()
    const session = this.sessions.get(args.paneKey)
    const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find((item) => item.chord === session?.chord)
    if (!session || session.sessionId !== args.sessionId || !shortcut) {
      return { status: 'unsupported' }
    }
    if (args.signal?.aborted) {
      return { status: 'unavailable' }
    }
    if (!session.view) {
      return { status: 'unavailable' }
    }
    session.pending?.finish({ status: 'busy' })
    session.pending = undefined
    if (session.view.agentId === args.agentId) {
      return { status: 'viewed' }
    }
    let finish: (result: ClaudeAgentViewResult) => void = () => {}
    const answer = new Promise<ClaudeAgentViewResult>((resolve) => {
      finish = resolve
    })
    const pending: PendingView = {
      requestId: randomUUID(),
      agentId: args.agentId,
      expiresAt: Date.now() + 1500,
      taken: false,
      finish
    }
    session.pending = pending
    const isCurrent = () =>
      !args.signal?.aborted &&
      this.sessions.get(args.paneKey) === session &&
      session.view !== undefined &&
      session.view.agentId !== args.agentId &&
      session.chord === shortcut.chord &&
      session.pending === pending &&
      pending.expiresAt >= Date.now() &&
      Date.now() - session.seenAt < SESSION_TTL_MS
    const timeout = setTimeout(() => finish({ status: 'timeout' }), 5500)
    const abort = () => finish({ status: 'unavailable' })
    args.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!(await args.trigger(shortcut.input, isCurrent))) {
        return { status: session.pending === pending ? 'unavailable' : 'busy' }
      }
      return await answer
    } catch (error) {
      if (session.pending !== pending) {
        return { status: 'busy' }
      }
      throw error
    } finally {
      clearTimeout(timeout)
      args.signal?.removeEventListener('abort', abort)
      if (session.pending === pending) {
        session.pending = undefined
      }
    }
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      session.pending?.finish({ status: 'unavailable' })
    }
    this.sessions.clear()
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.publish()
  }

  // Renewals only move deadlines later, so a pending timer may fire early but never late.
  private armExpiry(): void {
    if (this.expiryTimer || this.sessions.size === 0) {
      return
    }
    let deadline = Infinity
    for (const session of this.sessions.values()) {
      deadline = Math.min(deadline, session.seenAt + SESSION_TTL_MS)
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined
        this.prune()
        this.armExpiry()
      },
      Math.max(0, deadline - Date.now()) + EXPIRY_BATCH_MS
    )
    this.expiryTimer.unref()
  }

  private prune(): void {
    const size = this.sessions.size
    for (const [paneKey, session] of this.sessions) {
      if (Date.now() - session.seenAt >= SESSION_TTL_MS) {
        session.pending?.finish({ status: 'unavailable' })
        this.sessions.delete(paneKey)
      }
    }
    if (this.sessions.size !== size) {
      this.publish()
    }
  }
}
