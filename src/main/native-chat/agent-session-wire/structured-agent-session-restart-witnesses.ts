// Capture live work immediately before Stop and retain only proven interruptions; persisted running rows prove nothing.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { structuredAgentSessionWorkingAtStop } from './structured-agent-session-working-at-teardown'

type WorkingAtStopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

export type StructuredAgentSessionRestartWitnesses = {
  begin: (trigger: AgentSessionResumeTrigger) => void
  beforeStop: (sessionId: string) => void
  stopped: (sessionId: string) => void
  record: () => Promise<void>
  /** Explicit actions supersede unwritten witnesses only for readable agents in their audience. */
  clear: (audience?: (agent: string) => boolean) => void
}

export function createStructuredAgentSessionRestartWitnesses(deps: {
  sessions: ReadonlyMap<string, NonNullable<WorkingAtStopInput['session']>>
  getRecord: (
    sessionId: string
  ) => Pick<
    AgentSessionRecord,
    'provider' | 'providerHandleChain' | 'providerContextBoundary'
  > | null
  childWork: WorkingAtStopInput['childWork']
  childWorkOpen: WorkingAtStopInput['childWorkOpen']
  capsule?: Pick<AgentSessionRecoveryCapsule, 'record'>
  teardownId: string
  now: () => number
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartWitnesses {
  let trigger: AgentSessionResumeTrigger | null = null
  const stopping = new Map<string, AgentSessionResumeMarker>()
  const confirmed = new Map<string, AgentSessionResumeMarker>()
  const clear = (audience?: (agent: string) => boolean): void => {
    if (!audience) {
      trigger = null
      stopping.clear()
      confirmed.clear()
      return
    }
    for (const witnessed of [stopping, confirmed]) {
      for (const sessionId of witnessed.keys()) {
        const record = deps.getRecord(sessionId)
        if (record && audience(record.provider)) {
          witnessed.delete(sessionId)
        }
      }
    }
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
        childWork: deps.childWork,
        childWorkOpen: deps.childWorkOpen,
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
