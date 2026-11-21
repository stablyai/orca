import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { claudeAgentViewChord, readClaudeAgentViewChord } from './agent-view-keybindings'
import {
  ClaudeAgentViewMessage,
  type ClaudeAgentViewReply,
  type PendingView
} from './agent-view-messages'
import {
  MAX_CLAUDE_AGENT_VIEW_SESSIONS,
  ClaudeAgentViewRegistryFile,
  type RegisteredClaudeAgentView
} from './agent-view-registry-file'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  type ClaudeAgentViewObservation,
  type ClaudeAgentViewSnapshot,
  type ClaudeAgentViewResult
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

type ViewSession = RegisteredClaudeAgentView & { pending?: PendingView }

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

  /** Mods register only on change, so a restarted main reloads what idle Claudes told the last one;
   *  `isLive` drops panes whose Claude is gone. */
  restore(
    filePath: string,
    isLive: (session: RegisteredClaudeAgentView) => boolean = () => true
  ): Promise<void> {
    this.registry?.close()
    const registry = new ClaudeAgentViewRegistryFile(filePath, () =>
      [...this.sessions.values()].map(({ pending: _pending, ...session }) => session)
    )
    this.registry = registry
    return registry.restore((saved) => {
      let changed = false
      for (const session of saved) {
        const keep = !this.sessions.has(session.paneKey) && isLive(session)
        changed ||= !keep
        if (keep) {
          this.sessions.set(session.paneKey, session)
        }
      }
      this.publish()
      return changed
    })
  }

  private save(): void {
    void this.registry?.save()
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

  /** `sameMachine`: the mod's config folder is readable here (not a WSL or remote guest path). */
  receive(body: unknown, options: { sameMachine?: boolean } = {}): ClaudeAgentViewReply {
    const parsed = ClaudeAgentViewMessage.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    const current = this.sessions.get(message.paneKey)
    if (message.action === 'register') {
      const chord = claudeAgentViewChord(message.keybindings)
      if (!chord) {
        if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
          this.forget(message.paneKey)
        }
        return {}
      }
      if (!current && this.sessions.size >= MAX_CLAUDE_AGENT_VIEW_SESSIONS) {
        this.evictOldest()
      }
      const configDir = options.sameMachine ? message.configDir : undefined
      if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
        current.seenAt = Date.now()
        if (current.chord !== chord || current.configDir !== configDir) {
          current.chord = chord
          current.configDir = configDir
          this.save()
        }
      } else {
        current?.pending?.finish({ status: 'unavailable' })
        this.sessions.set(message.paneKey, {
          paneKey: message.paneKey,
          sessionId: message.sessionId,
          instanceId: message.instanceId,
          chord,
          seenAt: Date.now(),
          ...(configDir ? { configDir } : {})
        })
        this.publish()
        this.save()
      }
      const session = this.sessions.get(message.paneKey)
      if (session && message.view) {
        this.observe(session, message.view)
      }
      // durable: no heartbeat needed. A WSL mod keeps one: only it can see its keybindings change.
      return options.sameMachine ? { registered: true, durable: true } : { registered: true }
    }
    if (
      !current ||
      current.instanceId !== message.instanceId ||
      current.sessionId !== message.sessionId
    ) {
      return message.action === 'end' ? {} : { unknown: true } // the mod registers again
    }
    if (message.action === 'end') {
      this.forget(message.paneKey)
      return {}
    }
    if (message.action === 'observe') {
      this.observe(current, message.view)
      return { observed: true }
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
    const registered = this.sessions.get(args.paneKey)
    if (registered?.configDir && registered.sessionId === args.sessionId) {
      // An idle mod does not re-read its keybindings, so read the chord the user has bound now.
      const chord = await readClaudeAgentViewChord(registered.configDir)
      if (chord === undefined) {
        return { status: 'unavailable' }
      }
      if (this.sessions.get(args.paneKey) === registered && registered.chord !== chord) {
        if (chord) {
          registered.chord = chord
          this.save()
        } else {
          this.forget(args.paneKey)
        }
      }
    }
    const session = this.sessions.get(args.paneKey)
    const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find((item) => item.chord === session?.chord)
    if (!session || session.sessionId !== args.sessionId || !shortcut) {
      return { status: 'unsupported' }
    }
    if (args.signal?.aborted || !session.view) {
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

  /** Settles waiting views; the saved registry stays for the next main. */
  release(): void {
    for (const session of this.sessions.values()) {
      session.pending?.finish({ status: 'unavailable' })
    }
  }

  /** Stop: the saved registry outlives this main; memory and subscribers do not. */
  close(): void {
    this.release()
    this.registry?.close()
    this.registry = undefined
    this.sessions.clear()
    this.publish()
  }

  /** Drops a pane's entry: its Claude ended, its binding went away, or Orca dropped the pane. */
  forget(paneKey: string, sessionId?: string): void {
    const session = this.sessions.get(paneKey)
    if (!session || (sessionId && session.sessionId !== sessionId)) {
      return
    }
    session.pending?.finish({ status: 'unavailable' })
    this.sessions.delete(paneKey)
    this.publish()
    this.save()
  }

  private evictOldest(): void {
    let oldest: ViewSession | undefined
    for (const session of this.sessions.values()) {
      if (!oldest || session.seenAt < oldest.seenAt) {
        oldest = session
      }
    }
    if (oldest) {
      this.forget(oldest.paneKey)
    }
  }
}
