import type {
  ContinueInput,
  Retry,
  ProviderRetryDisposition,
  ProviderRetryCompletion,
  ProducerTransition
} from './structured-agent-session-provider-retry-types'
import {
  acceptProviderRetry,
  reconcileProviderRetry,
  observeProviderRetry
} from './structured-agent-session-provider-retry-observation'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionProviderRetryDelay } from '../../../shared/agent-session-provider-retry-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export {
  structuredAgentSessionProviderRetryPending,
  structuredAgentSessionProviderRetryStop,
  structuredAgentSessionProviderRetryCompletion,
  finishAbortedStructuredAgentSessionProviderRetry,
  retireStructuredAgentSessionProviderRetry,
  stageStructuredAgentSessionProviderTransition
} from './structured-agent-session-provider-retry-view'

export type {
  ProviderRetryCompletion,
  ProviderRetryDisposition
} from './structured-agent-session-provider-retry-types'

// Non-owning access for journal consumers; the host alone owns candidate/attempt lifetime.

export class StructuredAgentSessionProviderRetry {
  private readonly retries = new Map<string, Retry>()
  constructor(
    private readonly deps: {
      continueTurn: (
        input: Omit<ContinueInput, 'admitFreshInput'> & {
          isCurrent: () => boolean
          onWritten: () => void
          onAborted: () => void
        }
      ) => ReturnType<NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>>
      session: (id: string) => StructuredAgentSessionHostSession | undefined
      fence: (id: string) => number | null
      serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
      owesWork: (id: string) => boolean
      disposed: () => boolean
      publish: (id: string) => void
      settleCompletion: (
        id: string,
        journal: AgentSessionJournal,
        completion: ProviderRetryCompletion,
        disposition: ProviderRetryDisposition
      ) => void
    }
  ) {}

  retire(id: string, disposition: ProviderRetryDisposition = 'release'): boolean {
    const retry = this.retries.get(id)
    if (!retry) {
      return false
    }
    try {
      if (retry.currentResult) {
        this.deps.settleCompletion(
          id,
          retry.journal,
          { owner: retry, itemId: retry.currentResult.itemId },
          disposition
        )
      }
    } finally {
      clearTimeout(retry.timer)
      retry.abort.abort()
      this.retries.delete(id)
    }
    return true
  }
  dispose(): void {
    for (const id of this.retries.keys()) {
      this.retire(id, 'abandon')
    }
  }
  private current(id: string, retry: Retry): boolean {
    return (
      !this.deps.disposed() &&
      this.retries.get(id) === retry &&
      this.deps.session(id)?.journal === retry.journal &&
      this.deps.session(id)?.child === retry.child &&
      this.deps.fence(id) === retry.fence &&
      retry.journal.epoch === retry.epoch &&
      !retry.child.close
    )
  }
  stage(id: string, journal: AgentSessionJournal, transition: ProducerTransition): () => void {
    let retry = this.retries.get(id)
    if (retry && !this.current(id, retry)) {
      this.retire(id)
      retry = undefined
    }
    const child = this.deps.session(id)?.child
    const fence = this.deps.fence(id)
    if (
      this.deps.disposed() ||
      this.deps.session(id)?.journal !== journal ||
      !child ||
      child.close ||
      fence === null
    ) {
      return () => {}
    }
    if (!retry && !transition.transientTerminal) {
      return () => {}
    }
    if (!retry) {
      retry = {
        journal,
        epoch: journal.epoch,
        fence,
        child,
        attempt: 0,
        phase: 'candidate',
        written: false,
        abort: new AbortController()
      }
      this.retries.set(id, retry)
    }
    const identity = transition.turnLifecycle?.identity ?? transition.transientTerminal?.identity
    if (!identity) {
      return () => {}
    }
    const offered = {
      itemId: agentJournalItemKey(identity),
      category: transition.transientTerminal?.category,
      state: transition.turnLifecycle?.state
    }
    retry.offered = offered
    const owner = retry
    return () => {
      if (owner.offered === offered) {
        owner.offered = undefined
        if (!owner.currentResult && this.retries.get(id) === owner) {
          this.retire(id)
        }
      }
    }
  }
  observe(id: string, journal: AgentSessionJournal, rows: readonly JournalRow[] = []): void {
    return observeProviderRetry.call(this, id, journal, rows)
  }
  disposeResult(id: string, retry: Retry, disposition: ProviderRetryDisposition): void {
    const result = retry.currentResult
    if (result) {
      this.deps.settleCompletion(
        id,
        retry.journal,
        { owner: retry, itemId: result.itemId },
        disposition
      )
    }
  }
  private reconcile(id: string, retry: Retry, returned: string): void {
    return reconcileProviderRetry.call(this, id, retry, returned)
  }
  accept(id: string, retry: Retry): void {
    return acceptProviderRetry.call(this, id, retry)
  }
  schedule(id: string, retry: Retry): void {
    const terminal = retry.currentResult
    if (!terminal || !this.current(id, retry)) {
      return
    }
    const turn = retry.journal.itemBody(terminal.itemId)
    const delay = agentSessionProviderRetryDelay(retry.attempt + 1)
    if (
      !terminal.category ||
      turn?.kind !== 'turn' ||
      turn.outcome !== 'failure' ||
      delay === null
    ) {
      this.retire(id)
      return
    }
    retry.attempt++
    terminal.role = 'predecessor'
    retry.phase = 'waiting'
    retry.written = false
    retry.startedTurnRef = undefined
    retry.timer = setTimeout(() => {
      void this.fire(id, retry).catch(() => {
        if (this.retries.get(id) === retry) {
          this.retire(id)
          this.deps.publish(id)
        }
      })
    }, delay)
    retry.timer.unref?.()
  }
  private async fire(id: string, retry: Retry): Promise<void> {
    const claimed = await this.deps.serialize(id, async () => {
      if (!this.current(id, retry)) {
        if (this.retries.get(id) === retry) {
          this.retire(id)
        }
        return false
      }
      if (this.deps.owesWork(id)) {
        this.retire(id)
        this.deps.publish(id)
        return false
      }
      clearTimeout(retry.timer)
      retry.timer = undefined
      retry.phase = 'starting'
      return true
    })
    if (!claimed) {
      return
    }
    // Provider preparation, RPC, open and replay waits never own mutation ordering.
    const outcome = await this.deps.continueTurn({
      sessionId: id,
      fence: retry.fence,
      options: retry.options,
      signal: retry.abort.signal,
      isCurrent: () =>
        this.current(id, retry) && !retry.abort.signal.aborted && !this.deps.owesWork(id),
      onWritten: () => {
        retry.written = true
      },
      onAborted: () => retry.abort.abort()
    })
    await this.deps.serialize(id, async () => {
      if (!this.current(id, retry)) {
        if (this.retries.get(id) === retry) {
          this.retire(id)
        }
        return
      }
      if (outcome.state !== 'started') {
        // Stop's early abort may settle first; retain its captured write disposition until acceptance.
        retry.phase = 'settled'
        if (!retry.abort.signal.aborted) {
          this.retire(id)
        }
      } else {
        retry.startedTurnRef = outcome.providerTurnRef
        this.reconcile(id, retry, outcome.providerTurnRef)
      }
      this.deps.publish(id)
    })
  }
}
