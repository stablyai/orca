import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { confirmsMailWake } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import {
  failOnLaunchedAgentExit,
  LaunchedAgentExitedError,
  type LaunchedAgentExitRuntime
} from '../../../terminal/wait/launched-agent-exit-watch'

type Invocation = {
  stop: AbortController
  ended: boolean
}

/** Only this process's watched command can prove exit; persisted custody supplies no launch authority. */
export class MailWakeInvocations {
  private readonly invocations = new Map<string, Invocation>()
  private readonly waiters = new Set<{
    record: SleepingAgentSessionRecord
    finish: (value: boolean) => void
  }>()

  watch(record: SleepingAgentSessionRecord, runtime: LaunchedAgentExitRuntime): void {
    const attempt = record.mailWake?.attempt
    if (!attempt || this.invocations.has(attempt.launchToken)) {
      return
    }
    const invocation: Invocation = {
      stop: new AbortController(),
      ended: false
    }
    this.invocations.set(attempt.launchToken, invocation)
    void failOnLaunchedAgentExit(
      runtime,
      attempt.ptyId,
      record.agent,
      invocation.stop.signal,
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    ).catch((error: unknown) => {
      invocation.ended = error instanceof LaunchedAgentExitedError
    })
  }

  observe(
    record: SleepingAgentSessionRecord,
    rows: readonly AgentStatusIpcPayload[],
    ptyId: string | null | undefined
  ): boolean {
    const invocation = this.invocations.get(record.mailWake?.attempt?.launchToken ?? '')
    if (!rows.some((row) => confirmsMailWake(record, row, ptyId))) {
      return false
    }
    for (const waiter of this.waiters) {
      if (this.sameObligation(waiter.record, record)) {
        waiter.finish(true)
      }
    }
    invocation?.stop.abort()
    return true
  }

  ended(record: SleepingAgentSessionRecord): boolean {
    return this.invocations.get(record.mailWake?.attempt?.launchToken ?? '')?.ended === true
  }

  private sameObligation(a: SleepingAgentSessionRecord, b: SleepingAgentSessionRecord): boolean {
    return (
      a.paneKey === b.paneKey &&
      a.worktreeId === b.worktreeId &&
      a.agent === b.agent &&
      (a.connectionId ?? null) === (b.connectionId ?? null) &&
      agentProviderSessionsEqual(a.agent, a.providerSession, b.providerSession) &&
      (a.mailWake?.capturedAt ?? a.capturedAt) === (b.mailWake?.capturedAt ?? b.capturedAt) &&
      (!a.mailWake || a.mailWake.id === b.mailWake?.id)
    )
  }

  wait(record: SleepingAgentSessionRecord, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        signal.removeEventListener('abort', cancel)
        this.waiters.delete(waiter)
        resolve(value)
      }
      const cancel = () => finish(false)
      const waiter = { record, finish }
      this.waiters.add(waiter)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    })
  }

  retain(tokens: ReadonlySet<string>): void {
    for (const [token, invocation] of this.invocations) {
      if (!tokens.has(token)) {
        invocation.stop.abort()
        this.invocations.delete(token)
      }
    }
  }
}
