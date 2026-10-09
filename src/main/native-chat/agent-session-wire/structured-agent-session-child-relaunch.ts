// An idle child that cannot run the chat's new mode resumes with the required launch flag.
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentChildRelaunchSession = Pick<
  StructuredAgentSessionHostSession,
  'child'
> & {
  journal: Pick<AgentSessionJournal, 'activeTurnId' | 'visitItems'>
}

export async function relaunchOutgrownStructuredAgentSessionChild(
  input: {
    session: StructuredAgentChildRelaunchSession | undefined
    adapter: Pick<StructuredAgentSessionAdapter, 'childRelaunchRequired'>
    /** What the child still serves besides its journal; owed work keeps it, as the sweep does. */
    work: StructuredAgentSessionChildWorkReads
    /** Puts the child to rest; inside the caller's serialize. */
    restChild: () => Promise<void>
    logger: StructuredAgentSessionLogger
  },
  sessionId: string
): Promise<void> {
  const { session, adapter } = input
  const child = session?.child
  if (!session || !child || child.phase !== 'ready' || child.close) {
    return
  }
  if (!adapter.childRelaunchRequired?.(sessionId)) {
    return
  }
  if (structuredAgentSessionChildHasOpenWork(session.journal, input.work)) {
    return
  }
  try {
    await input.restChild()
  } catch (error) {
    // The send still goes: a child that would not stop keeps serving it under the old launch.
    input.logger.warn('relaunching a child for its new launch options failed', {
      scope: 'child-relaunch',
      sessionId,
      error
    })
  }
}
