// Host reads behind outgrown-child retirement and the account move a running child defers.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
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
import { AccountMoveHolds } from './structured-agent-session-account-move-holds'
import { keepStructuredAgentSessionSendForAccountMove } from './structured-agent-session-account-move-keep'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'

export type StructuredAgentSessionAccountTransitionRead = (
  sessionId: string,
  options?: {
    /** A pass-shared read of the account a start would use, when the caller has one. */
    launchHome?: () => Promise<AgentSessionAccountHome | null>
    /** Only look: a caller with no waiting person card leaves the chat's hold alone. */
    observe?: false
  }
) => Promise<StructuredAgentSessionAccountTransition | null>

const KEEP_RETRY_MS = 5_000

export function createStructuredAgentSessionOutgrownChildHost(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  clientDelivery: Pick<
    StructuredAgentSessionClientDelivery,
    'readChildWork' | 'childWorkOpen' | 'readStopping'
  >
  stopOutgrownAgent: (sessionId: string) => Promise<void>
  /** Look again for work a held chat can now send. */
  wake: (sessionId: string) => void
}) {
  const { deps, sessions, clientDelivery } = input
  const now = () => deps.now?.() ?? Date.now()
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
  const holds = new AccountMoveHolds(input.wake, () => deps.accountMoveWakes, now, sessions)

  return {
    retainedWork,
    retire: async (
      sessionId: string,
      continuingId?: string,
      next?: AgentJournalSubmission
    ): Promise<StructuredAgentSessionOutgrownChild> => {
      const session = await unlessStopping(sessionId)
      const outcome = await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
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
        now,
        logger: deps.logger
      })
      if (outcome.kind !== 'deferred' || !outcome.transition || !next || !session) {
        return outcome
      }
      // Owed work showed up only after the send was accepted: it must not reach the old account.
      const kept = await keepStructuredAgentSessionSendForAccountMove(
        sessionId,
        session.journal,
        structuredAgentSessionConversationFence(deps.store, sessionId),
        next,
        deps.logger
      )
      if (kept === 'failed') {
        // Nothing else may wake a send left pending; try again shortly, never in a tight loop.
        setTimeout(() => input.wake(sessionId), KEEP_RETRY_MS).unref?.()
      }
      return kept === 'not-persons' ? outcome : { kind: 'withheld' }
    },
    accountTransition: (async (sessionId, options) => {
      const session = sessions.get(sessionId)
      const held = holds.reusable(session, sessionId)
      if (held?.fresh) {
        return held.transition
      }
      const reading = await unlessStopping(sessionId)
      const read = holds.begin(sessionId)
      const transition = await readStructuredAgentSessionAccountTransition(reading, {
        work: retainedWork(sessionId),
        launchAccountHome: options?.launchHome ?? launchAccountHome(sessionId),
        now,
        ...(held ? { known: held.transition } : {})
      }).catch((error: unknown) => {
        holds.end(sessionId, read)
        throw error
      })
      if (holds.end(sessionId, read) && options?.observe !== false) {
        holds.observe(sessions.get(sessionId), sessionId, transition)
      }
      return transition
    }) satisfies StructuredAgentSessionAccountTransitionRead,
    /** A held chat whose hold no edge has touched: nothing it holds can be sent yet. */
    accountMoveHeld: (sessionId: string): boolean =>
      holds.reusable(sessions.get(sessionId), sessionId)?.fresh === true,
    /** Its child work settled: a hold waiting on it is read again. */
    accountMoveEvidence: (sessionId: string) => holds.stale(sessionId, 'work'),
    accountMoveSettled: (sessionId: string): null => {
      holds.observe(sessions.get(sessionId), sessionId, null)
      return null
    },
    dispose: () => holds.dispose()
  }
}
