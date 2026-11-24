import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { claudeAgentViewChord, readClaudeAgentViewChord } from './agent-view-keybindings'
import {
  answerPendingView,
  claudeAgentViewSnapshot,
  clickReadableConfigDir,
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
  isLive: (paneKey: string, sessionId: string) => boolean = () => true // the hook server's status rows
  private publishQueued = false
  private lastFrame = '[]'

  subscribe(listener: (snapshot: ClaudeAgentViewSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    this.lastFrame = '' // this listener may hold a state the next queued frame would skip
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Idle mods stay quiet, so a restarted main reloads them; `isLive` drops panes whose Claude is gone. */
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
        // Saved panes go ahead of the cap: their idle Claudes can't register again.
        const keep =
          !this.sessions.has(session.paneKey) &&
          this.sessions.size < MAX_CLAUDE_AGENT_VIEW_SESSIONS * 2 && // what the file reader accepts
          isLive(session)
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
    return claudeAgentViewSnapshot(this.sessions.values())
  }

  // One frame per task however many panes changed (a worktree removal drops many), none unchanged.
  private publish(): void {
    if (this.publishQueued) {
      return
    }
    this.publishQueued = true
    queueMicrotask(() => {
      this.publishQueued = false
      const snapshot = this.snapshot()
      const frame = JSON.stringify(snapshot)
      if (frame !== this.lastFrame) {
        this.lastFrame = frame
        for (const listener of this.listeners) {
          listener(snapshot)
        }
      }
    })
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

  receive(body: unknown, options: { sameMachine?: boolean } = {}): ClaudeAgentViewReply {
    const parsed = ClaudeAgentViewMessage.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    const current = this.sessions.get(message.paneKey)
    if (message.action === 'register') {
      const known = current?.instanceId === message.instanceId
      // Refuses a post that outlived its pane or its session (/clear); the mod retries.
      if (!known && !this.isLive(message.paneKey, message.sessionId)) {
        return {}
      }
      const chord = claudeAgentViewChord(message.keybindings)
      const configDir = clickReadableConfigDir(message.configDir, options.sameMachine)
      // A local pane stays without a binding: each click reads the binding from configDir.
      if (!chord && !configDir) {
        if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
          this.forget(message.paneKey)
        }
        return { unbound: true }
      }
      if (!current && this.sessions.size >= MAX_CLAUDE_AGENT_VIEW_SESSIONS) {
        return {} // full: an idle pane can't re-register, so refuse the newcomer; it retries
      }
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
          seenAt: Date.now(),
          ...(chord ? { chord } : {}),
          ...(configDir ? { configDir } : {})
        })
        this.publish()
        this.save()
      }
      const session = this.sessions.get(message.paneKey)
      if (session && message.view) {
        this.observe(session, message.view)
      }
      // durable only with a config folder a click can read here; others (WSL, relative) keep checking in.
      return configDir ? { registered: true, durable: true } : { registered: true }
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
    return answerPendingView(current.pending, message)
  }

  saved(): Promise<boolean> {
    return this.registry?.settled() ?? Promise.resolve(false)
  }

  async view(args: {
    paneKey: string
    sessionId: string
    agentId?: string
    trigger: (input: string, isCurrent: () => boolean) => Promise<boolean>
    signal?: AbortSignal
  }): Promise<ClaudeAgentViewResult> {
    if (!this.sessions.has(args.paneKey)) {
      await this.registry?.retryUnread()
    }
    const registered = this.sessions.get(args.paneKey)
    if (registered?.configDir && registered.sessionId === args.sessionId) {
      // An idle mod won't re-read its keybindings; read them here, keeping the sent chord if unreadable.
      const chord = await readClaudeAgentViewChord(registered.configDir)
      if (
        chord !== undefined &&
        this.sessions.get(args.paneKey) === registered &&
        registered.chord !== (chord ?? undefined)
      ) {
        registered.chord = chord ?? undefined
        this.save()
      }
    }
    const session = this.sessions.get(args.paneKey)
    const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find((item) => item.chord === session?.chord)
    if (!session || session.sessionId !== args.sessionId || !shortcut) {
      return { status: 'unsupported' }
    }
    // A checking-in mod (WSL, Windows, relative config) that went quiet may be stopped: 15 s rule.
    const fresh = () => session.configDir !== undefined || Date.now() - session.seenAt <= 15_000
    if (args.signal?.aborted || !session.view || !fresh()) {
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
      fresh()
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

  release(): void {
    for (const session of this.sessions.values()) {
      session.pending?.finish({ status: 'unavailable' })
      session.pending = undefined
    }
  }

  close(): void {
    this.release()
    this.registry?.close()
    this.registry = undefined
    this.sessions.clear()
    this.publish()
  }

  /** Drops entries of `sessionId` whose own pane `isLive` no longer vouches for (a moved, dead pane). */
  forgetSession(sessionId: string, isLive: (paneKey: string) => boolean): void {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId && !isLive(session.paneKey)) {
        this.forget(session.paneKey)
      }
    }
  }

  forget(paneKey: string, sessionId?: string): boolean {
    const session = this.sessions.get(paneKey)
    if (!session || (sessionId && session.sessionId !== sessionId)) {
      return false
    }
    session.pending?.finish({ status: 'unavailable' })
    this.sessions.delete(paneKey)
    this.publish()
    this.save()
    return true
  }
}
