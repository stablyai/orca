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

export type StructuredAgentSessionAccountTransitionRead = (
  sessionId: string,
  /** A pass-shared read of the account a start would use, when the caller has one. */
  launchHome?: () => Promise<AgentSessionAccountHome | null>
) => Promise<StructuredAgentSessionAccountTransition | null>

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
        now,
        logger: deps.logger
      })
    },
    accountTransition: (async (sessionId, launchHome) => {
      const transition = await readStructuredAgentSessionAccountTransition(
        await unlessStopping(sessionId),
        {
          work: retainedWork(sessionId),
          launchAccountHome: launchHome ?? launchAccountHome(sessionId),
          now
        }
      )
      holds.observe(sessions.get(sessionId), sessionId, transition)
      return transition
    }) satisfies StructuredAgentSessionAccountTransitionRead,
    accountMoveSettled: (sessionId: string): null => {
      holds.observe(sessions.get(sessionId), sessionId, null)
      return null
    },
    dispose: () => holds.dispose()
  }
}

/** Chats whose person-sent work waits for an account move, and the edges that may release it
 *  without a journal write: a Dispatch closing, a selection change, a wake-up that never came. */
class AccountMoveHolds {
  private readonly held = new Map<string, ReturnType<typeof setTimeout> | null>()
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly wake: (sessionId: string) => void,
    private readonly wakes: () => StructuredAgentSessionHostDeps['accountMoveWakes'],
    private readonly now: () => number,
    private readonly sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  ) {}

  observe(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string,
    transition: StructuredAgentSessionAccountTransition | null
  ): void {
    if (this.disposed) {
      return
    }
    const wasHeld = this.held.has(sessionId)
    if (!transition || !session) {
      if (session) {
        delete session.awaitsAccountMove
      }
      this.release(sessionId)
      if (wasHeld && session) {
        // Republish so the queue stops naming the held card's wait.
        this.wake(sessionId)
      }
      return
    }
    this.clearTimer(sessionId)
    session.awaitsAccountMove = true
    const until = transition.wakeUpUntil
    const timer =
      until === undefined
        ? null
        : setTimeout(() => this.wakeOrRelease(sessionId), Math.max(0, until - this.now()) + 1)
    timer?.unref?.()
    this.held.set(sessionId, timer)
    this.unsubscribe ??= this.wakes()?.subscribe(() => {
      for (const id of this.held.keys()) {
        this.wakeOrRelease(id)
      }
    })
    if (!wasHeld) {
      this.wake(sessionId)
    }
  }

  /** A chat closed while held has nothing left to send. */
  private wakeOrRelease(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.wake(sessionId)
    } else {
      this.release(sessionId)
    }
  }

  private release(sessionId: string): void {
    this.clearTimer(sessionId)
    this.held.delete(sessionId)
    if (this.held.size === 0) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  private clearTimer(sessionId: string): void {
    const timer = this.held.get(sessionId)
    if (timer) {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.held.keys()) {
      this.clearTimer(id)
    }
    this.held.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}
