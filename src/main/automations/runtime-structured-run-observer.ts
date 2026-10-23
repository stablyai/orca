import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionRequest
} from '../../shared/structured-agent-session-latest-request'
import { projectStructuredAgentSessionStatusState } from '../../shared/structured-agent-session-projection'

const STRUCTURED_RUN_HANDLE_PREFIX = 'structured-automation-session:'
const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000
const POLL_INTERVAL_MS = 1_000

export function structuredAutomationRunHandle(sessionId: string): string {
  return `${STRUCTURED_RUN_HANDLE_PREFIX}${sessionId}`
}

export function parseStructuredAutomationRunHandle(handle: string): string | null {
  return handle.startsWith(STRUCTURED_RUN_HANDLE_PREFIX)
    ? handle.slice(STRUCTURED_RUN_HANDLE_PREFIX.length) || null
    : null
}

function snapshotOfText(text: string): AutomationRunOutputSnapshot | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  const buffer = createHeadlessAutomationOutputSnapshotBuffer()
  buffer.append(trimmed)
  return buffer.snapshot()
}

async function readStructuredCompletionState(
  host: StructuredAgentSessionHost,
  sessionId: string,
  since: number
): Promise<AutomationRunCompletionObservation | null> {
  try {
    const journal = await host.journalSnapshot(sessionId)
    const state = projectStructuredAgentSessionStatusState(journal.items, journal.submissions)
    if (
      state.owesWork ||
      state.summary.status === 'working' ||
      state.summary.status === 'attention'
    ) {
      return null
    }
    const request =
      state.latestRequest ?? latestStructuredAgentSessionRequest(journal.items, journal.submissions)
    if (!request || request.turnState === 'running') {
      return null
    }
    if (request.settledAt !== undefined && request.settledAt < since) {
      return null
    }
    if (!request.outcome) {
      return null
    }
    const assistantText = latestStructuredAgentSessionAssistantMessage(journal.items)
    const outputSnapshot = snapshotOfText(assistantText)
    if (request.outcome === 'success') {
      return { status: 'completed', outputSnapshot, error: null }
    }
    return {
      status: 'dispatch_failed',
      outputSnapshot,
      error: `Automation structured session turn ended with ${request.outcome}.`
    }
  } catch {
    return null
  }
}

export async function observeStructuredAutomationRunCompletion(args: {
  sessionId: string
  signal: AbortSignal
  since: number
  getHost?: () => StructuredAgentSessionHost | null
}): Promise<AutomationRunCompletionObservation> {
  const getHost = args.getHost ?? getStructuredAgentSessionHost
  const deadlineAt = Date.now() + OBSERVE_DEADLINE_MS

  while (Date.now() < deadlineAt) {
    if (args.signal.aborted) {
      throw new Error('request_aborted')
    }
    const host = getHost()
    if (host) {
      const immediate = await readStructuredCompletionState(host, args.sessionId, args.since)
      if (immediate) {
        return immediate
      }
      const settled = await waitForNextTurnCompletionOrTimeout(
        host,
        args.sessionId,
        args.since,
        args.signal,
        Math.min(POLL_INTERVAL_MS, Math.max(1, deadlineAt - Date.now()))
      )
      if (settled) {
        return settled
      }
    } else {
      await sleep(POLL_INTERVAL_MS, args.signal)
    }
  }

  return {
    status: 'dispatch_failed',
    outputSnapshot: null,
    error: 'Orca stopped watching this run after 6h without a completion signal.'
  }
}

async function waitForNextTurnCompletionOrTimeout(
  host: StructuredAgentSessionHost,
  sessionId: string,
  since: number,
  signal: AbortSignal,
  timeoutMs: number
): Promise<AutomationRunCompletionObservation | null> {
  return new Promise<AutomationRunCompletionObservation | null>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('request_aborted'))
      return
    }
    let settled = false
    let unsubscribe = (): void => {}
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
    const finish = (result: AutomationRunCompletionObservation | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    unsubscribe = host.subscribeTurnCompletions({
      id: `automation:observe:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      emit: (event) => {
        if (event.type !== 'completion' || event.completion.sessionId !== sessionId) {
          return
        }
        if (event.completion.completedAt < since) {
          return
        }
        void readStructuredCompletionState(host, sessionId, since).then((observation) => {
          if (observation) {
            finish(observation)
          }
        })
      }
    })
  })
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('request_aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
