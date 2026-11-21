import { agentProviderSessionsEqual } from '../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { confirmsMailWake, type SleptMailRecord } from './mail-wake-obligation'
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
    record: SleptMailRecord
    finish: (value: boolean) => void
  }>()

  watch(record: SleptMailRecord, runtime: LaunchedAgentExitRuntime): void {
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
    record: SleptMailRecord,
    rows: readonly AgentStatusIpcPayload[],
    ptyId: string | null | undefined
  ): boolean {
    if (!rows.some((row) => confirmsMailWake(record, row, ptyId))) {
      return false
    }
    this.confirm(record)
    return true
  }

  /** The wake's own process is running its agent: settle waiters and stop watching it. */
  confirm(record: SleptMailRecord): void {
    const invocation = this.invocations.get(record.mailWake?.attempt?.launchToken ?? '')
    for (const waiter of this.waiters) {
      if (this.sameObligation(waiter.record, record)) {
        waiter.finish(true)
      }
    }
    invocation?.stop.abort()
  }

  ended(record: SleptMailRecord): boolean {
    return this.invocations.get(record.mailWake?.attempt?.launchToken ?? '')?.ended === true
  }

  private sameObligation(a: SleptMailRecord, b: SleptMailRecord): boolean {
    return (
      a.paneKey === b.paneKey &&
      a.worktreeId === b.worktreeId &&
      a.agent === b.agent &&
      (a.connectionId ?? null) === (b.connectionId ?? null) &&
      agentProviderSessionsEqual(a.agent, a.providerSession, b.providerSession) &&
      a.capturedAt === b.capturedAt &&
      (!a.mailWake || a.mailWake.id === b.mailWake?.id)
    )
  }

  wait(record: SleptMailRecord, signal: AbortSignal): Promise<boolean> {
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

  /** Stops watching one settled attempt's process. */
  release(launchToken: string | undefined): void {
    const invocation = launchToken ? this.invocations.get(launchToken) : undefined
    if (launchToken && invocation) {
      invocation.stop.abort()
      this.invocations.delete(launchToken)
    }
  }
}
