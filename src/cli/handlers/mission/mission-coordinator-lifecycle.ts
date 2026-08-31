import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { finishMissionCoordinator, type MissionCoordinator } from './mission-coordinator'

export function manageMissionCoordinator(client: RuntimeClient, coordinator: MissionCoordinator) {
  let mayHaveUnsettledRun = false
  let interrupted = false
  let finishing: Promise<void> | undefined
  const finish = () => {
    finishing ??= finishMissionCoordinator(client, coordinator, mayHaveUnsettledRun)
    return finishing
  }
  const interrupt = () => {
    interrupted = true
    // Why: a second Ctrl+C must not bypass the in-flight, single cleanup attempt.
    void finish().finally(() => process.exit(130))
  }
  process.on('SIGINT', interrupt)
  return {
    beforeRun() {
      if (interrupted) {
        throw new RuntimeClientError(
          'mission_cancelled',
          'Mission interrupted before Run creation.'
        )
      }
      mayHaveUnsettledRun = true
    },
    markSettled() {
      mayHaveUnsettledRun = false
    },
    finish,
    dispose() {
      process.removeListener('SIGINT', interrupt)
    }
  }
}
