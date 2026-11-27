import type { OrchestrationSessionWorker } from '../../../../../shared/orchestration-session-workers'
import type { RemoteConnectorWorker } from '../../db/connector-workers/remote-connector-workers'
import type { PeerServerAnswerStatus } from '../peer-mail/peer-mail-relay'

export function remoteConnectorActivity(
  worker: RemoteConnectorWorker,
  heard: PeerServerAnswerStatus | undefined
): Pick<OrchestrationSessionWorker, 'state' | 'activity'> {
  return {
    state:
      worker.linkState === 'open' && heard?.answeredAt && !heard.unreachableSince
        ? 'working'
        : 'unverifiable',
    activity: 'unknown'
  }
}
