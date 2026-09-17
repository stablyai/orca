import type {
  StructuredAgentSessionLateSettlement,
  StructuredAgentSessionLateSettlementResult
} from '../native-chat/agent-session-wire/structured-agent-session-late-settlement'

const RETRY_DELAYS_MS = [25, 100, 500] as const

type PendingTerminalSettlement = {
  input: StructuredAgentSessionLateSettlement
  generation: string
  running: boolean
  retryIndex: number
  timer: ReturnType<typeof setTimeout> | null
}

export class CodexStructuredLateSettlementRecovery {
  private readonly pending = new Map<string, PendingTerminalSettlement>()

  constructor(
    private readonly deps: {
      settle: (
        input: StructuredAgentSessionLateSettlement
      ) => void | Promise<StructuredAgentSessionLateSettlementResult>
      generation: () => string | null
      recover: (error: Error) => void | Promise<boolean>
    }
  ) {}

  settle(
    input: StructuredAgentSessionLateSettlement
  ): Promise<StructuredAgentSessionLateSettlementResult> {
    let result: void | Promise<StructuredAgentSessionLateSettlementResult>
    try {
      result = this.deps.settle(input)
    } catch (error) {
      this.failed(input, error)
      return Promise.resolve('evidence-not-durable')
    }
    if (!result) {
      return Promise.resolve('no-obligation')
    }
    return result.then(
      (outcome) => {
        if (outcome !== 'evidence-not-durable') {
          this.forget(input.clientMessageId)
        }
        return outcome
      },
      (error: unknown) => {
        this.failed(input, error)
        return 'evidence-not-durable'
      }
    )
  }

  observeActivity(): void {
    const generation = this.deps.generation()
    for (const obligation of this.pending.values()) {
      if (obligation.generation !== generation) {
        this.forget(obligation.input.clientMessageId)
      } else if (!obligation.running && !obligation.timer) {
        this.retry(obligation)
      }
    }
  }

  clear(): void {
    for (const obligation of this.pending.values()) {
      if (obligation.timer) {
        clearTimeout(obligation.timer)
      }
    }
    this.pending.clear()
  }

  private failed(input: StructuredAgentSessionLateSettlement, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    if ('state' in input) {
      this.remember(input)
    }
    if (!this.pending.has(input.clientMessageId)) {
      this.remember(input)
    }
    const recovery = this.deps.recover(failure)
    if (!recovery) {
      this.schedule(input.clientMessageId)
      return
    }
    void recovery.then(
      (closed) => {
        if (!closed) {
          this.schedule(input.clientMessageId)
        }
      },
      () => this.schedule(input.clientMessageId)
    )
  }

  private remember(input: StructuredAgentSessionLateSettlement): void {
    const generation = this.deps.generation()
    if (!generation) {
      return
    }
    const existing = this.pending.get(input.clientMessageId)
    if (existing) {
      existing.input = input
      return
    }
    this.pending.set(input.clientMessageId, {
      input,
      generation,
      running: false,
      retryIndex: 0,
      timer: null
    })
  }

  private schedule(clientMessageId: string): void {
    const obligation = this.pending.get(clientMessageId)
    if (!obligation || obligation.running || obligation.timer) {
      return
    }
    const delay = RETRY_DELAYS_MS[obligation.retryIndex]
    if (delay === undefined) {
      return
    }
    obligation.retryIndex += 1
    obligation.timer = setTimeout(() => {
      obligation.timer = null
      this.retry(obligation)
    }, delay)
    obligation.timer.unref?.()
  }

  private retry(obligation: PendingTerminalSettlement): void {
    if (
      this.pending.get(obligation.input.clientMessageId) !== obligation ||
      this.deps.generation() !== obligation.generation
    ) {
      this.forget(obligation.input.clientMessageId)
      return
    }
    obligation.running = true
    let result: void | Promise<StructuredAgentSessionLateSettlementResult>
    try {
      result = this.deps.settle(obligation.input)
    } catch (error) {
      obligation.running = false
      this.failed(obligation.input, error)
      return
    }
    if (!result) {
      obligation.running = false
      this.forget(obligation.input.clientMessageId)
      return
    }
    void result.then(
      (outcome) => {
        obligation.running = false
        if (outcome === 'settled' || outcome === 'no-obligation') {
          this.forget(obligation.input.clientMessageId)
        }
      },
      (error: unknown) => {
        obligation.running = false
        this.failed(obligation.input, error)
      }
    )
  }

  private forget(clientMessageId: string): void {
    const obligation = this.pending.get(clientMessageId)
    if (obligation?.timer) {
      clearTimeout(obligation.timer)
    }
    this.pending.delete(clientMessageId)
  }
}
