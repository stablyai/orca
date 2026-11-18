// Capture live work immediately before Stop and retain only proven interruptions; persisted running rows prove nothing.

import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import { restartActivityWaitsOnPerson } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-activity'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentSessionRecoveryCapsule } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { structuredAgentSessionWorkingAtStop } from '../termination/structured-agent-session-working-at-teardown'
import { crashCutResumeMarker } from './structured-agent-session-crash-cut-marker'

type WorkingAtStopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

export type StructuredAgentSessionRestartWitnesses = {
  begin: (trigger: AgentSessionResumeTrigger) => void
  beforeStop: (sessionId: string) => void
  stopped: (sessionId: string) => void
  record: () => Promise<void>
  /** After a crash: open each chat the dead run held (which settles it) and record what it cut. */
  recordCrashCuts: (
    cuts: readonly { sessionId: string; crashedRuntime: string }[],
    settledSince: number
  ) => Promise<number>
  /** Ends a launch's automatic turn; what still waits is left to a person from then on. */
  passOverAutomatic: () => Promise<void>
  cutOf: StructuredAgentSessionRestartResume['cutOf']
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
  capsule?: Pick<
    AgentSessionRecoveryCapsule,
    'record' | 'passOverAutomatic' | 'list' | 'listFailed'
  >
  /** Opening a chat whose run died settles it. */
  open: (sessionId: string) => Promise<{ readable: boolean }>
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
  const crashCutOf = async (
    { sessionId, crashedRuntime }: { sessionId: string; crashedRuntime: string },
    settledSince: number
  ): Promise<AgentSessionResumeMarker | null> => {
    const readable = (await deps.open(sessionId)).readable
    const journal = deps.sessions.get(sessionId)?.journal
    const record = deps.getRecord(sessionId)
    if (!readable || !journal || !record) {
      return null
    }
    return crashCutResumeMarker({
      sessionId,
      cut: await journal.reads.restartCut(),
      record,
      crashedRuntime,
      settledSince
    })
  }
  return {
    begin: (next) => {
      clear()
      trigger = next
    },
    beforeStop: async (sessionId) => {
      stopping.delete(sessionId)
      if (trigger === null) {
        return
      }
      const marker = await structuredAgentSessionWorkingAtStop({
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
    recordCrashCuts: async (cuts, settledSince) => {
      const markers: AgentSessionResumeMarker[] = []
      for (const cut of cuts) {
        // A chat that cannot be read keeps no offer; its worker is reported as stopped instead.
        const marker = await crashCutOf(cut, settledSince).catch(() => null)
        if (marker) {
          markers.push(marker)
        }
      }
      // One write for every chat the crash cut.
      if (markers.length > 0) {
        await deps.enqueue(async () => deps.capsule?.record(markers, deps.now()))
      }
      return markers.length
    },
    cutOf: async (sessionId) => {
      const now = deps.now()
      const offer =
        (await deps.capsule?.list(now))?.find((marker) => marker.sessionId === sessionId) ??
        (await deps.capsule?.listFailed(now))?.find(
          (failure) => failure.marker.sessionId === sessionId
        )?.marker
      const journal = deps.sessions.get(sessionId)?.journal
      if (offer && offer.work.kind === 'turn') {
        if (!restartActivityWaitsOnPerson(offer.activity)) {
          return { cause: offer.trigger, turnId: offer.work.id }
        }
        const prompts = journal ? (await journal.reads.restartCut()).promptItemIds : []
        return {
          cause: offer.trigger,
          turnId: offer.work.id,
          waitingOn: { promptItemId: prompts.at(-1) ?? null }
        }
      }
      const cut = journal ? await journal.reads.orcaStopCut() : null
      const turn = cut && journal ? await journal.reads.item(cut.turnItemId) : null
      const turnId = readAgentJournalTurn(turn?.body)?.turnId
      return cut && turnId ? { cause: cut.cause, turnId } : null
    },
    passOverAutomatic: async () => {
      await deps.enqueue(async () => deps.capsule?.passOverAutomatic(deps.now()))
    },
    clear
  }
}
