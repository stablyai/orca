import type { OrcaRuntimeService } from '../../orca-runtime'
import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { isHostShuttingDown } from '../../../startup/quit/host-shutdown-state'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { ownsOrcadProfileDirectory } from '../../../orcad/instance-lock/orcad-instance-lock-hold'
import { sweepAntigravityReplyOnlyHomes } from '../../../antigravity/antigravity-reply-only-root'

type ServingRuntime = Pick<
  OrcaRuntimeService,
  'openAgentSessionRecordStore' | 'startPullRequestWatches'
>

function startOldChatHistoryCleanup(runtime: ServingRuntime): void {
  void runtime.openAgentSessionRecordStore().catch((error: unknown) => {
    createStructuredAgentSessionLogger().error(
      'old chat journal: not checked (chat store failed to open)',
      {
        scope: 'old-chat-history-cleanup-open',
        error
      }
    )
  })
}

function startAntigravityReplyOnlyHomeSweep(dataDirectory?: string): void {
  const root = dataDirectory ?? (hasAppEnvironment() ? getProfileUserDataPath() : null)
  if (!root || !ownsOrcadProfileDirectory(root)) {
    return
  }
  const logger = createStructuredAgentSessionLogger()
  void sweepAntigravityReplyOnlyHomes(root, logger).catch((error: unknown) => {
    logger.warn('Antigravity reply-only startup sweep failed', {
      scope: 'antigravity-reply-only',
      dataDirectory: root,
      error
    })
  })
}

export function agentSessionRecordStoreHostServing(
  runtime: ServingRuntime,
  dataDirectory?: string
): void {
  if (isHostShuttingDown()) {
    return
  }
  startOldChatHistoryCleanup(runtime)
  startAntigravityReplyOnlyHomeSweep(dataDirectory)
  runtime.startPullRequestWatches({ admit: true })
}
