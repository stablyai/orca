import { isDaemonAsyncIoStalled } from './daemon-async-io-probe'
import type { DaemonHealthRequests } from './daemon-health-requests'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import type { TerminalHost } from './terminal-host'
import type {
  StalledDaemonRestartRequest,
  StalledDaemonRestartResult
} from '../../shared/daemon-async-io-health'

export type ShutdownRequest = {
  id: string
  type: 'shutdown'
  payload: {
    killSessions: boolean
  }
}

export type ShutdownStalledOwnerRequest = {
  id: string
  type: 'shutdownStalledOwner'
  payload: StalledDaemonRestartRequest
}

export async function shutdownStalledOwner(
  request: ShutdownStalledOwnerRequest,
  options: {
    identity?: { pid: number; startedAtMs: number | null; launchNonce: string | null }
    admission: Pick<DaemonTerminalAdmission, 'inFlight'>
    host: Pick<TerminalHost, 'listSessions'>
    health: Pick<DaemonHealthRequests, 'handle'>
    isAcceptingWork: () => boolean
    shutdown: () => Promise<unknown>
  }
): Promise<StalledDaemonRestartResult> {
  const { owner, sessions } = request.payload
  const identity = options.identity
  if (
    !identity ||
    !options.isAcceptingWork() ||
    owner.pid !== identity.pid ||
    owner.startedAtMs !== identity.startedAtMs ||
    owner.launchNonce !== identity.launchNonce ||
    options.admission.inFlight !== 0
  ) {
    return { status: 'refused' }
  }
  const health = await options.health.handle({ id: request.id, type: 'asyncIoHealth' })
  if (
    !options.isAcceptingWork() ||
    !health ||
    typeof health !== 'object' ||
    !('state' in health) ||
    health.state !== 'stalled' ||
    !isDaemonAsyncIoStalled() ||
    options.admission.inFlight !== 0
  ) {
    return { status: 'refused' }
  }
  const live = options.host.listSessions().filter((s) => s.state !== 'exited')
  if (
    live.length !== sessions.length ||
    new Set(sessions.map((s) => s.sessionId)).size !== sessions.length ||
    live.some(
      (s) =>
        !sessions.some(
          (expected) =>
            expected.sessionId === s.sessionId && expected.incarnationId === s.incarnationId
        )
    )
  ) {
    return { status: 'refused' }
  }
  // No await between the inventory check and shutdown closing daemon admission.
  await options.shutdown()
  return { status: 'restarted', killedCount: live.length }
}
