import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead
} from '../../shared/agent-session-attention'
import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLatestRequest } from '../../shared/structured-agent-session-latest-request'

export type AutomationTerminalPublication = {
  source: object
  cursor: AgentJournalCursor
  root: string
  submission: string
  request: StructuredAgentSessionLatestRequest
  origin: StructuredAttentionOrigin
}

export type AutomationAttentionResult = {
  take: () => AutomationAttentionDelivery | undefined
  release: () => void
}
export type AutomationAttentionDelivery = {
  origin: () => StructuredAttentionOrigin | undefined
  covered: () => boolean
  release: () => void
}

/** The service/observer, then writer, owns death; accepted reads own coverage, never publication. */
export class AutomationAttentionCorrelation {
  private phase: 'observing' | 'sealed' | 'writing' | 'closed' = 'observing'
  private source: object | null = null
  private epoch: string | undefined
  private terminal: AutomationTerminalPublication | undefined
  private terminalKey: string | undefined
  private read = false
  private sessionId: string | undefined

  constructor(
    private readonly move: (previous: string | undefined, next: string | undefined) => void,
    private readonly remove: () => void
  ) {}

  observe(
    sessionId: string,
    source: object | null,
    cursor: AgentJournalCursor | undefined,
    terminal: AutomationTerminalPublication | undefined,
    historical: boolean
  ): void {
    if (this.phase !== 'observing') {
      return
    }
    if (this.sessionId !== sessionId) {
      this.move(this.sessionId, sessionId)
      this.sessionId = sessionId
    }
    if (source !== this.source || cursor?.epoch !== this.epoch) {
      this.terminal = undefined
      this.terminalKey = undefined
      this.read = false
      this.source = source
      this.epoch = cursor?.epoch
    }
    if (
      this.terminal &&
      terminal &&
      (this.terminal.root !== terminal.root || this.terminal.submission !== terminal.submission)
    ) {
      this.terminal = undefined
      this.read = false
    }
    if (!terminal && this.terminalKey) {
      this.terminal = undefined
      this.read = false
    }
    const key = terminal
      ? JSON.stringify([
          terminal.root,
          terminal.submission,
          terminal.request.kind,
          terminal.request.id,
          terminal.request.turnState,
          terminal.request.outcome
        ])
      : undefined
    if (!historical && terminal && key !== this.terminalKey && !this.terminal) {
      this.terminal = terminal
    }
    this.terminalKey = key
  }

  acknowledge(read: StructuredAttentionRead): void {
    if (this.terminal && attentionOriginWasRead(this.terminal.origin, read)) {
      this.read = true
    }
  }

  seal(
    match: Omit<AutomationTerminalPublication, 'origin' | 'cursor'> & { epoch: string }
  ): AutomationAttentionResult | undefined {
    if (this.phase !== 'observing') {
      return undefined
    }
    const terminal = this.terminal
    if (
      !terminal ||
      terminal.source !== match.source ||
      terminal.cursor.epoch !== match.epoch ||
      terminal.root !== match.root ||
      terminal.submission !== match.submission ||
      terminal.request.kind !== match.request.kind ||
      terminal.request.id !== match.request.id ||
      terminal.request.outcome !== match.request.outcome ||
      terminal.request.turnState !== match.request.turnState
    ) {
      this.abandon()
      return undefined
    }
    this.phase = 'sealed'
    return {
      take: () => {
        if (this.phase !== 'sealed') {
          return undefined
        }
        this.phase = 'writing'
        return {
          origin: () => this.terminal?.origin,
          covered: () => this.read,
          release: () => this.release()
        }
      },
      release: () => {
        if (this.phase === 'sealed') {
          this.release()
        }
      }
    }
  }

  abandon(): void {
    if (this.phase === 'observing') {
      this.release()
    }
  }

  release(): void {
    if (this.phase === 'closed') {
      return
    }
    this.phase = 'closed'
    this.move(this.sessionId, undefined)
    this.terminal = undefined
    this.source = null
    this.remove()
  }
}

export class AutomationAttentionCorrelations {
  private readonly sessions = new Map<string, Set<AutomationAttentionCorrelation>>()

  createOwner() {
    const runs = new Map<string, AutomationAttentionCorrelation>()
    let disposed = false
    return {
      get: (id: string) => runs.get(id),
      admit: (id: string) => {
        if (disposed) {
          return undefined
        }
        const existing = runs.get(id)
        if (existing) {
          return existing
        }
        const entry = new AutomationAttentionCorrelation(
          (previous, next) => {
            if (previous) {
              const entries = this.sessions.get(previous)
              entries?.delete(entry)
              if (entries?.size === 0) {
                this.sessions.delete(previous)
              }
            }
            if (next) {
              let entries = this.sessions.get(next)
              if (!entries) {
                this.sessions.set(next, (entries = new Set()))
              }
              entries.add(entry)
            }
          },
          () => runs.delete(id)
        )
        runs.set(id, entry)
        return entry
      },
      release: (id: string) => runs.get(id)?.release(),
      dispose: () => {
        disposed = true
        for (const entry of runs.values()) {
          entry.release()
        }
      }
    }
  }

  acknowledge(read: StructuredAttentionRead): void {
    for (const entry of this.sessions.get(read.sessionId) ?? []) {
      entry.acknowledge(read)
    }
  }
}
export type AutomationAttentionOwner = ReturnType<AutomationAttentionCorrelations['createOwner']>
