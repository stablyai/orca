import { ClaudeChatSession, nodeSpawn } from './claude-session'
import type { ClaudeStreamEvent } from './claude-chat-events'
import type { ChatCheckpoints } from './chat-checkpoints'

type SpawnFn = ConstructorParameters<typeof ClaudeChatSession>[0]['spawn']

type ClaudeChatManagerDeps = {
  send: (channel: string, payload: unknown) => void
  spawn?: SpawnFn
  checkpoints?: ChatCheckpoints
}

export class ClaudeChatManager {
  private readonly sessions = new Map<string, ClaudeChatSession>()
  private readonly deps: ClaudeChatManagerDeps

  constructor(deps: ClaudeChatManagerDeps) {
    this.deps = deps
  }

  async send(
    worktreeId: string,
    cwd: string,
    text: string,
    opts?: { model?: string; effort?: string; attachments?: string[] }
  ): Promise<void> {
    // Why: get-or-create the session synchronously, BEFORE the await below —
    // otherwise two concurrent sends could each create a session and the
    // second sessions.set() would orphan the first child process.
    const session = this.getOrCreateSession(worktreeId, cwd)

    // Why: snapshot before forwarding to claude so the user can rewind to the
    // state just before each message was sent (mirrors VS Code's Rewind feature).
    if (this.deps.checkpoints !== undefined) {
      const cp = await this.deps.checkpoints.snapshot(cwd, text.slice(0, 50))
      if (cp !== null) {
        this.deps.send('claudeChat:event', {
          worktreeId,
          event: { type: 'checkpoint', sha: cp.sha, createdAt: cp.createdAt, label: cp.label }
        })
      }
    }
    // Why: claude resolves @path mentions in the prompt text; appending them here
    // keeps attachment handling out of the session and in the manager layer.
    const attachmentSuffix =
      opts?.attachments && opts.attachments.length > 0
        ? `\n${opts.attachments.map((p) => `@${p}`).join(' ')}`
        : ''
    session.send(text + attachmentSuffix, { model: opts?.model, effort: opts?.effort })
  }

  private getOrCreateSession(worktreeId: string, cwd: string): ClaudeChatSession {
    let session = this.sessions.get(worktreeId)
    if (session === undefined) {
      session = new ClaudeChatSession({
        cwd,
        spawn: this.deps.spawn ?? nodeSpawn,
        onEvent: (event: ClaudeStreamEvent) => {
          this.deps.send('claudeChat:event', { worktreeId, event })
        }
      })
      this.sessions.set(worktreeId, session)
    }
    return session
  }

  resume(worktreeId: string, cwd: string, sessionId: string): void {
    // Why: set the sessionId so the next send uses --resume.
    this.getOrCreateSession(worktreeId, cwd).setSessionId(sessionId)
  }

  // Why: lets the renderer restore the right conversation when the user
  // switches worktrees — each project keeps its own live session.
  status(worktreeId: string): { sessionId: string | null; running: boolean } {
    const session = this.sessions.get(worktreeId)
    if (session === undefined) {
      return { sessionId: null, running: false }
    }
    return { sessionId: session.getSessionId(), running: session.isRunning() }
  }

  reset(worktreeId: string): void {
    // Why: drop the session so the next send starts a fresh conversation with no --resume.
    this.stop(worktreeId)
  }

  stop(worktreeId: string): void {
    const session = this.sessions.get(worktreeId)
    if (session !== undefined) {
      session.stop()
      this.sessions.delete(worktreeId)
    }
  }

  stopAll(): void {
    for (const [worktreeId] of this.sessions) {
      this.stop(worktreeId)
    }
  }

  // Why: exposed for tests to assert session reuse without accessing the private map.
  sessionCount(): number {
    return this.sessions.size
  }
}
