import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { TraexAppServerConnection } from './traex-app-server-connection'
import type { TraexSession } from './traex-session'

const NAME_TIMEOUT_MS = 20_000

/** Prefer the live thread's own naming so the CLI and Orca agree on one title. */
export function traexGenerateConversationName(
  sessions: ReadonlyMap<string, TraexSession>,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['generateConversationName']>>[0]
): Promise<string | null> {
  return sessions.get(input.record.sessionId)?.extras.generateName() ?? Promise.resolve(null)
}

export async function renameTraexSession(
  sessions: ReadonlyMap<string, TraexSession>,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['renameProviderSession']>>[0],
  renameAtRest: StructuredAgentSessionAdapter['renameProviderSession']
): Promise<void> {
  const session = sessions.get(input.record.sessionId)
  await (session?.threadId === input.providerSessionId && !session.connection.closed
    ? session.connection.request('thread/name/set', {
        threadId: input.providerSessionId,
        name: input.name
      })
    : renameAtRest?.(input))
}

/** Ask the CLI to name its own thread, then persist the name for TUI clients. */
export class TraexThreadNaming {
  private pending: {
    resolve: (name: string | null) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly connection: TraexAppServerConnection,
    private readonly threadId: string
  ) {}

  generate(): Promise<string | null> {
    if (this.connection.closed || this.pending) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(null)
      }, NAME_TIMEOUT_MS)
      timer.unref()
      this.pending = { resolve, timer }
      this.connection
        .request('thread/name/generate', {
          threadId: this.threadId,
          requestId: randomUUID()
        })
        .catch(() => this.settle(null))
    })
  }

  resolve(name: string): void {
    // A late name after the host fell back to its own naming must not rename the thread.
    if (!this.settle(name)) {
      return
    }
    void this.connection
      .request('thread/name/setIfUnnamed', { threadId: this.threadId, name })
      .catch(() => {})
  }

  dispose(): void {
    this.settle(null)
  }

  private settle(name: string | null): boolean {
    const pending = this.pending
    if (!pending) {
      return false
    }
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve(name)
    return true
  }
}
