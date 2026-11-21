import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { claudeAgentViewChord } from './agent-view-keybindings'
import {
  ClaudeAgentViewIdentity as Identity,
  MAX_CLAUDE_AGENT_VIEW_SESSIONS,
  ClaudeAgentViewRegistryFile,
  type RegisteredClaudeAgentView
} from './agent-view-registry-file'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  ClaudeAgentViewObservation,
  type ClaudeAgentViewSnapshot,
  type ClaudeAgentViewResult
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

const Message = z.discriminatedUnion('action', [
  Identity.extend({
    action: z.literal('register'),
    keybindings: z.string().max(128 * 1024),
    view: ClaudeAgentViewObservation.optional()
  }),
  Identity.extend({ action: z.literal('observe'), view: ClaudeAgentViewObservation }),
  Identity.extend({ action: z.literal('take') }),
  Identity.extend({
    action: z.literal('ack'),
    requestId: z.string().max(64),
    deny: z.string().max(1024).optional()
  }),
  Identity.extend({ action: z.literal('end') })
])

type PendingView = {
  requestId: string
  agentId?: string
  expiresAt: number
  taken: boolean
  finish: (result: ClaudeAgentViewResult) => void
}

type ViewSession = RegisteredClaudeAgentView & { pending?: PendingView }

type BridgeReply = {
  registered?: true
  unknown?: true
  requestId?: string
  agentId?: string
  expiresAt?: number
}

export class ClaudeAgentViewBridge {
  private readonly sessions = new Map<string, ViewSession>()
  private readonly listeners = new Set<(snapshot: ClaudeAgentViewSnapshot) => void>()
  private registry?: ClaudeAgentViewRegistryFile

  subscribe(listener: (snapshot: ClaudeAgentViewSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Mods register only on change, so a restarted main reloads what idle Claudes told the last one. */
  async restore(filePath: string): Promise<void> {
    const registry = new ClaudeAgentViewRegistryFile(filePath)
    this.registry = registry
    const saved = await registry.load()
    if (this.registry !== registry) {
      return
    }
    for (const session of saved) {
      if (!this.sessions.has(session.paneKey)) {
        this.sessions.set(session.paneKey, session)
      }
    }
    this.publish()
  }

  private save(): void {
    void this.registry?.save(
      [...this.sessions.values()].map(({ pending: _pending, ...session }) => session)
    )
  }

  private snapshot(): ClaudeAgentViewSnapshot {
    return [...this.sessions.values()].flatMap((session) =>
      session.view
        ? [
            {
              paneKey: session.paneKey,
              sessionId: session.sessionId,
              ...(session.view.agentId ? { agentId: session.view.agentId } : {})
            }
          ]
        : []
    )
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private observe(session: ViewSession, view: z.infer<typeof ClaudeAgentViewObservation>): void {
    if (session.view && session.view.revision >= view.revision) {
      return
    }
    const changed = !session.view || session.view.agentId !== view.agentId
    session.view = view
    if (changed) {
      this.publish()
      this.save()
    }
  }

  receive(body: unknown): BridgeReply {
    const parsed = Message.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    const current = this.sessions.get(message.paneKey)
    if (message.action === 'register') {
      const chord = claudeAgentViewChord(message.keybindings)
      if (!chord) {
        if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
          current.pending?.finish({ status: 'unavailable' })
          this.sessions.delete(message.paneKey)
          this.publish()
          this.save()
        }
        return {}
      }
      if (!current && this.sessions.size >= MAX_CLAUDE_AGENT_VIEW_SESSIONS) {
        this.evictOldest()
      }
      if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
        current.seenAt = Date.now()
        if (current.chord !== chord) {
          current.chord = chord
          this.save()
        }
      } else {
        current?.pending?.finish({ status: 'unavailable' })
        this.sessions.set(message.paneKey, {
          paneKey: message.paneKey,
          sessionId: message.sessionId,
          instanceId: message.instanceId,
          chord,
          seenAt: Date.now()
        })
        this.publish()
        this.save()
      }
      const session = this.sessions.get(message.paneKey)
      if (session && message.view) {
        this.observe(session, message.view)
      }
      return { registered: true }
    }
    if (
      !current ||
      current.instanceId !== message.instanceId ||
      current.sessionId !== message.sessionId
    ) {
      // Asks a mod this main never heard from (or forgot) to register again.
      return message.action === 'end' ? {} : { unknown: true }
    }
    if (message.action === 'end') {
      current.pending?.finish({ status: 'unavailable' })
      this.sessions.delete(message.paneKey)
      this.publish()
      this.save()
      return {}
    }
    if (message.action === 'observe') {
      this.observe(current, message.view)
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
      pending.expiresAt >= Date.now()
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

  /** Settles waiting views; the registry stays saved for the next main, whose mods stay quiet. */
  release(): void {
    for (const session of this.sessions.values()) {
      session.pending?.finish({ status: 'unavailable' })
    }
  }

  /** Stop: the saved registry outlives this main; memory and subscribers do not. */
  close(): void {
    this.release()
    this.registry = undefined
    this.sessions.clear()
    this.publish()
  }

  private evictOldest(): void {
    let oldest: ViewSession | undefined
    for (const session of this.sessions.values()) {
      if (!oldest || session.seenAt < oldest.seenAt) {
        oldest = session
      }
    }
    if (oldest) {
      oldest.pending?.finish({ status: 'unavailable' })
      this.sessions.delete(oldest.paneKey)
      this.publish()
    }
  }
}
