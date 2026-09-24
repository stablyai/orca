// Teardown's word on which sessions were genuinely working when the app went away.
//
// Captured from the live runtime at teardown, confirmed per session once its child has stopped,
// and only then written. A marker is never derived from a persisted `running` row, which survives
// a crash and would resurrect work nobody is doing.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { StructuredAgentSessionRestartCandidateReader } from './structured-agent-session-restart-candidates'
import { structuredAgentSessionsWorkingAtTeardown } from './structured-agent-session-working-at-teardown'

export type StructuredAgentSessionRestartWitnesses = {
  capture: (trigger: AgentSessionResumeTrigger) => void
  confirmStopped: (sessionId: string) => void
  record: () => Promise<void>
  /** An explicit action on the offer supersedes witnesses this host has not yet written. */
  clear: () => void
}

export function createStructuredAgentSessionRestartWitnesses(deps: {
  sessions: Parameters<typeof structuredAgentSessionsWorkingAtTeardown>[0]['sessions']
  getRecord: (sessionId: string) => AgentSessionRecord | null
  derive: StructuredAgentSessionRestartCandidateReader
  capsule?: Pick<AgentSessionRecoveryCapsule, 'record'>
  teardownId: string
  now: () => number
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartWitnesses {
  let captured = new Map<string, AgentSessionResumeMarker>()
  const confirmed = new Map<string, AgentSessionResumeMarker>()
  const clear = (): void => {
    confirmed.clear()
    captured.clear()
  }
  return {
    capture: (trigger) => {
      clear()
      captured = new Map(
        structuredAgentSessionsWorkingAtTeardown({
          sessions: deps.sessions,
          getRecord: deps.getRecord,
          trigger,
          teardownId: deps.teardownId,
          now: deps.now()
        }).map((marker) => [marker.sessionId, marker])
      )
    },
    confirmStopped: (sessionId) => {
      const marker = captured.get(sessionId)
      captured.delete(sessionId)
      try {
        if (
          marker &&
          deps.derive([marker], 'may-be-held', { providerStopped: true }).length === 1
        ) {
          confirmed.set(sessionId, marker)
        }
      } catch {
        console.warn('[structured-agent-session] recovery witness validation failed')
      }
    },
    record: async () => {
      await deps.enqueue(async () => {
        await deps.capsule?.record([...confirmed.values()], deps.now())
      })
    },
    clear
  }
}
