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
import {
  AccountMoveHolds,
  type AccountMoveReader
} from './structured-agent-session-account-move-holds'
import { keepStructuredAgentSessionSendForAccountMove } from './structured-agent-session-account-move-keep'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'

export type StructuredAgentSessionAccountTransitionRead = (
  sessionId: string,
  options?: {
    /** A pass-shared read of the account a start would use, when the caller has one. */
    launchHome?: () => Promise<AgentSessionAccountHome | null>
    /** Who waits on the answer; a usage-limit continue does not make the queue read as held. */
    reader?: AccountMoveReader
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
  const holds = new AccountMoveHolds({
    wake: input.wake,
    wakes: () => deps.accountMoveWakes,
    dispatchKey: (sessionId) => deps.accountMoveWakes?.dispatchKey?.(sessionId),
    dispatchOpen: (sessionId) => retainedWork(sessionId).hasOpenDispatch(),
    now,
    sessions
  })

  return {
    retainedWork,
    retire: async (
      sessionId: string,
      continuingId?: string,
      next?: AgentJournalSubmission
    ): Promise<StructuredAgentSessionOutgrownChild> => {
      const session = await unlessStopping(sessionId)
      const { launchTools } = deps
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
        ...(launchTools ? { launchToolsChanged: () => launchTools.changed(sessionId) } : {}),
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
      if (kept === 'not-persons') {
        return outcome
      }
      // Held at once, so the kept card is not claimed again before the hold is read.
      holds.observe(session, sessionId, outcome.transition, 'person')
      return { kind: 'withheld' }
    },
    accountTransition: (async (sessionId, options) => {
      const session = sessions.get(sessionId)
      const reader = options?.reader ?? 'person'
      const held = holds.reusable(session, sessionId)
      if (held?.fresh) {
        holds.adopt(session, sessionId, reader)
        return held.transition
      }
      const staysOnAccount = !held && holds.staysOnAccount(session)
      const reading = await unlessStopping(sessionId)
      const read = holds.begin(sessionId)
      let noMove = false
      const transition = await readStructuredAgentSessionAccountTransition(reading, {
        work: retainedWork(sessionId),
        launchAccountHome: options?.launchHome ?? launchAccountHome(sessionId),
        now,
        onNoMove: () => {
          noMove = true
        },
        ...(staysOnAccount ? { staysOnAccount } : {}),
        ...(held ? { known: held.transition } : {})
      }).catch((error: unknown) => {
        holds.end(sessionId, read)
        throw error
      })
      if (holds.end(sessionId, read)) {
        if (noMove && !staysOnAccount) {
          holds.staysOnAccountFrom(sessions.get(sessionId))
        }
        holds.observe(sessions.get(sessionId), sessionId, transition, reader)
      }
      return transition
    }) satisfies StructuredAgentSessionAccountTransitionRead,
    accountMoveHeld: (sessionId: string): boolean =>
      holds.heldForPerson(sessions.get(sessionId), sessionId),
    /** Its child work settled: a hold waiting on it is read again. */
    accountMoveEvidence: (sessionId: string) => holds.stale(sessionId, 'work'),
    /** `reader` no longer waits on the chat's move (no person card, or no continue due). */
    accountMoveSettled: (sessionId: string, reader: AccountMoveReader = 'person'): null => {
      holds.forget(sessions.get(sessionId), sessionId, reader)
      return null
    },
    dispose: () => holds.dispose()
  }
}
