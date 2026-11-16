// Host reads behind outgrown-child retirement and the account move a running child defers.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import {
  structuredAgentSessionInputCompilerPermission,
  structuredAgentSessionLaunchPermission
} from '../options/structured-agent-session-launch-permission'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import {
  readStructuredAgentSessionAccountTransition,
  retireOutgrownStructuredAgentSessionChild,
  type StructuredAgentSessionAccountTransition,
  type StructuredAgentSessionOutgrownChild
} from './structured-agent-session-outgrown-child'

export function createStructuredAgentSessionOutgrownChildHost(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  clientDelivery: Pick<
    StructuredAgentSessionClientDelivery,
    'readChildWork' | 'childWorkOpen' | 'readStopping'
  >
  stopOutgrownAgent: (sessionId: string) => Promise<void>
}) {
  const { deps, sessions, clientDelivery } = input
  const workHost = { store: deps.store, sessions }
  const retainedWork = (sessionId: string, continuingId?: string) => ({
    currentWork: () =>
      readHostStructuredAgentSessionWork(workHost, sessionId, { kind: 'child-work' }),
    childWork: () => clientDelivery.readChildWork(sessionId),
    childWorkOpen: () => clientDelivery.childWorkOpen(sessionId),
    hasOpenDispatch: () => {
      const record = deps.store.getConversation(sessionId)
      return record !== null && deps.hasOpenDispatch?.(record) === true
    },
    providerHoldsDispatch: () =>
      deps.adapter.holdsDispatch?.(sessionId) === true ||
      [...(sessions.get(sessionId)?.child?.heldSends?.() ?? [])].some((id) => id !== continuingId)
  })
  const launchAccountHome = (sessionId: string) => async () => {
    const record = deps.store.getRecord(sessionId)
    return record ? ((await deps.launchAccountHome?.(record, 'identity')) ?? null) : null
  }
  // Personal Stop holds handover meanwhile; its next step decides.
  const unlessStopping = async (sessionId: string) =>
    (await clientDelivery.readStopping(sessionId)) ? undefined : sessions.get(sessionId)

  return {
    retainedWork,
    retire: async (
      sessionId: string,
      continuingId?: string,
      next?: AgentJournalSubmission
    ): Promise<StructuredAgentSessionOutgrownChild> => {
      const session = await unlessStopping(sessionId)
      return retireOutgrownStructuredAgentSessionChild(sessionId, session, {
        next,
        requiresModelTransitionRestart: (submission) =>
          session?.child?.phase === 'ready' &&
          deps.adapter.requiresModelTransitionRestart?.({
            sessionId,
            fence: session.child.fence,
            executionOptions: submission.options
          }) === true,
        work: retainedWork(sessionId, continuingId),
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
        stopAgent: (sessionId) => {
          deps.store.requireWritableRecord(sessionId)
          return input.stopOutgrownAgent(sessionId)
        },
        launchAccountHome: launchAccountHome(sessionId),
        logger: deps.logger
      })
    },
    /** Read under the chat's serialization. */
    accountTransition: async (
      sessionId: string
    ): Promise<StructuredAgentSessionAccountTransition | null> =>
      readStructuredAgentSessionAccountTransition(await unlessStopping(sessionId), {
        work: retainedWork(sessionId),
        launchAccountHome: launchAccountHome(sessionId)
      })
  }
}
