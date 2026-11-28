// Replace a chat's agent the chat outgrew: before a send's handover, or after an account switch.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import {
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildOwesWork
} from '../recovery/structured-agent-session-outgrown-child'
import { readJournalSqlWorkAnswerOnce } from '../../agent-session-journal/journal-sql-work-answer'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import {
  structuredAgentSessionLaunchPermission,
  structuredAgentSessionInputCompilerPermission
} from '../options/structured-agent-session-launch-permission'

type RetirementDeps = Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2]

type StructuredAgentSessionOutgrownRetirement = (
  sessionId: string,
  continuingId: string | undefined,
  next: AgentJournalSubmission | undefined,
  /** An account switch, told of a selection while `committed()` holds. */
  committed?: () => boolean
) => Promise<void>

export function createStructuredAgentSessionOutgrownRetirement(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  retainedWork: (sessionId: string, continuingId?: string) => RetirementDeps['work']
  readStopping: StructuredAgentSessionClientDelivery['readStopping']
  stopOutgrownAgent: (sessionId: string, onlyIf?: () => boolean) => Promise<void>
}): StructuredAgentSessionOutgrownRetirement {
  const { deps, sessions } = input
  const { launchTools } = deps
  const workHost = { store: deps.store, sessions }
  return async (sessionId, continuingId, next, committed) => {
    // Defer retirement while personal Stop holds handover; its next step decides.
    const session = (await input.readStopping(sessionId)) ? undefined : sessions.get(sessionId)
    await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
      next,
      requiresModelTransitionRestart: (submission) =>
        session?.child?.phase === 'ready' &&
        deps.adapter.requiresModelTransitionRestart?.({
          sessionId,
          fence: session.child.fence,
          executionOptions: submission.options
        }) === true,
      work: input.retainedWork(sessionId, continuingId),
      launchPermission: async () => {
        const record = deps.store.getRecord(sessionId)
        return (
          structuredAgentSessionInputCompilerPermission(session?.journal, continuingId) ??
          (record ? structuredAgentSessionLaunchPermission(deps, record) : null)
        )
      },
      permissionRequiresAcquisition: (mode) =>
        structuredAgentSessionInputCompilerPermission(session?.journal, continuingId)
          ? true
          : (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) ??
            mode !== session?.child?.permissionMode),
      stopAgent: (sessionId, onlyIf) => {
        deps.store.requireWritableRecord(sessionId)
        return input.stopOutgrownAgent(sessionId, onlyIf)
      },
      launchAccountHome: async () => {
        const record = deps.store.getRecord(sessionId)
        return record ? ((await deps.launchAccountHome?.(record, 'identity')) ?? null) : null
      },
      launchToolsChanged: async () => {
        const kept = await deps.adapter.keptLaunchOutgrown?.(
          sessionId,
          launchTools?.outdated(sessionId) === true,
          () => structuredAgentSessionChildOwesWork(input.retainedWork(sessionId, continuingId))
        )
        // Pending: not durable yet, so not retired here; the send's handover holds it.
        return kept === 'pending'
          ? false
          : (kept ?? (await launchTools?.changed(sessionId)) === true)
      },
      logger: deps.logger,
      ...(committed && session
        ? {
            accountSwitch: {
              committed,
              // One attempt: provider writes that keep moving the journal leave the agent alone
              // rather than holding the chat's lane.
              currentWorkOnce: () =>
                readJournalSqlWorkAnswerOnce(
                  session.journal,
                  () => captureHostStructuredAgentSessionWork(workHost, sessionId, session.journal),
                  { kind: 'child-work' }
                )
            }
          }
        : {})
    })
  }
}

/** After an account switch: stop the chat's agent, under the chat's serialization, when it runs on
 *  another account than the committed selection and owes no work. A running delivery or a queued
 *  send leaves it to that send's handover, which replaces it as before. */
export function retireStructuredAgentSessionChildOnOtherAccount(
  sessionId: string,
  input: {
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
    serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
    delivering: (sessionId: string) => boolean
    retire: StructuredAgentSessionOutgrownRetirement
    committed: () => boolean
  }
): Promise<void> {
  return input.serialize(sessionId, async () => {
    const session = input.sessions.get(sessionId)
    if (!session?.child || input.delivering(sessionId)) {
      return
    }
    const { submission } = await session.journal.reads.input({ kind: 'first-queued' })
    if (!submission) {
      await input.retire(sessionId, undefined, undefined, input.committed)
    }
  })
}
