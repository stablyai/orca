// Teardown's word on which sessions were genuinely working when the app went away.
//
// Taken per session from the live runtime right before teardown stops that session's child — the
// last moment its turn, its pending prompts and the provider's background roster are all still
// what the sidebar showed — and kept once the stop is proven. That snapshot IS the offer; nothing
// re-judges it once the child is gone. A marker is never derived from a persisted `running` row,
// which survives a crash and would resurrect work nobody is doing.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { structuredAgentSessionWorkingAtStop } from './structured-agent-session-working-at-teardown'

type WorkingAtStopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

export type StructuredAgentSessionRestartWitnesses = {
  /** Starts a teardown: witnesses from an earlier one are forgotten. */
  begin: (trigger: AgentSessionResumeTrigger) => void
  /** Right before this session's provider child is stopped. */
  beforeStop: (sessionId: string) => void
  /** The child is proven gone, so what it was doing was cut off. */
  stopped: (sessionId: string) => void
  record: () => Promise<void>
  /** An explicit action on the offer supersedes witnesses this host has not yet written. */
  clear: () => void
}

export function createStructuredAgentSessionRestartWitnesses(deps: {
  sessions: ReadonlyMap<string, NonNullable<WorkingAtStopInput['session']>>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  backgroundTasks: WorkingAtStopInput['backgroundTasks']
  capsule?: Pick<AgentSessionRecoveryCapsule, 'record'>
  teardownId: string
  now: () => number
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartWitnesses {
  let trigger: AgentSessionResumeTrigger | null = null
  const stopping = new Map<string, AgentSessionResumeMarker>()
  const confirmed = new Map<string, AgentSessionResumeMarker>()
  const clear = (): void => {
    trigger = null
    stopping.clear()
    confirmed.clear()
  }
  return {
    begin: (next) => {
      clear()
      trigger = next
    },
    beforeStop: (sessionId) => {
      stopping.delete(sessionId)
      if (trigger === null) {
        return
      }
      const marker = structuredAgentSessionWorkingAtStop({
        sessionId,
        session: deps.sessions.get(sessionId),
        getRecord: deps.getRecord,
        backgroundTasks: deps.backgroundTasks,
        trigger,
        teardownId: deps.teardownId,
        now: deps.now()
      })
      if (marker) {
        stopping.set(sessionId, marker)
      }
    },
    stopped: (sessionId) => {
      const marker = stopping.get(sessionId)
      stopping.delete(sessionId)
      if (marker) {
        confirmed.set(sessionId, marker)
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
