import type { LaunchWork } from './prepared-agent-launch-execution'
import type { PreparedAgentLaunchStatus } from './prepared-agent-launch-protocol'

export function snapshotPreparedLaunch(work: LaunchWork): PreparedAgentLaunchStatus {
  const status = structuredClone(work.status)
  const live = work.liveSetup?.()
  // Main rejoins its known Setup from here, never from a host-wide inventory.
  if (status.setup && live?.paneKey && live.terminalHandle) {
    status.setup.pane = { paneKey: live.paneKey, terminalHandle: live.terminalHandle }
  }
  return status
}

export function waitForPreparedLaunch(
  work: LaunchWork,
  requestedMs: number,
  until: 'setup' | 'launch' = 'launch'
): Promise<PreparedAgentLaunchStatus> {
  const ready = () =>
    (until === 'setup' && work.status.setup?.incarnationId !== undefined) ||
    (work.status.execution !== 'not-dispatched' && work.status.execution !== 'dispatching')
  if (ready()) {
    return Promise.resolve(snapshotPreparedLaunch(work))
  }
  return new Promise((resolve) => {
    const done = () => {
      if (!ready()) {
        return
      }
      finish()
    }
    const finish = () => {
      clearTimeout(timer)
      work.changed.delete(done)
      resolve(snapshotPreparedLaunch(work))
    }
    const timer = setTimeout(finish, Math.max(1, Math.min(10_000, requestedMs)))
    work.changed.add(done)
  })
}
