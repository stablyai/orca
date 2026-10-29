// An idle warm agent takes a newly saved mode at once; anything else waits for the next send's relaunch.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import { structuredAgentSessionChildOwesWork } from './structured-agent-session-outgrown-child'
import { markProviderChildPermission } from './structured-agent-session-provider-child'

export async function applyStructuredAgentSessionPermissionLive(
  deps: Pick<
    StructuredAgentSessionHostDeps,
    'store' | 'agents' | 'modelCatalog' | 'adapter' | 'logger'
  >,
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined,
  work: Parameters<typeof structuredAgentSessionChildOwesWork>[1]
): Promise<void> {
  const child = session?.child
  const record = deps.store.getRecord(sessionId)
  if (
    !session ||
    !child ||
    !record ||
    child.phase !== 'ready' ||
    child.close ||
    !deps.adapter.applyPermissionMode ||
    session.journal.submissions().some(isQueuedAgentJournalSubmission) ||
    structuredAgentSessionChildOwesWork(session.journal, work)
  ) {
    return
  }
  const mode = await structuredAgentSessionLaunchPermission(deps, record)
  // Own settings are read only at launch.
  if (mode === null || mode === 'own' || mode === child.permissionMode) {
    return
  }
  const identity = { generation: child.generation, fence: child.fence }
  try {
    if (await deps.adapter.applyPermissionMode(sessionId, mode)) {
      markProviderChildPermission(session, identity, mode)
    }
  } catch (error) {
    deps.logger.warn('switching a running agent to a new permission mode failed', {
      scope: 'live-permission',
      sessionId,
      error
    })
  }
}
