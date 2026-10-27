/** Reverify the displayed incarnation before restarting, since every hosted process will end. */
import { getDaemonRuntimeDir } from './daemon-launch-paths'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { inspectDaemonHostImage } from './daemon-host-image'
import {
  clearSeveredDaemon,
  getSeveredDaemon,
  isSameIncarnation,
  type SeveredDaemonController,
  type SeveredDaemonIncarnation,
  type SeveredDaemonRestartResult
} from './daemon-host-image-state'
import { getCurrentDaemonAdapter } from './daemon-provider-routing'
import { restartDaemon } from './daemon-provider-restart'
import { getDaemonProvider } from './daemon-provider-state'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { getDaemonPidPath } from './daemon-spawner'

type Dependencies = {
  inspect: () => ReturnType<typeof inspectDaemonHostImage>
  restart: (expectedDaemonPid: number) => Promise<{ killedCount: number }>
  listSessions: () => Promise<{ isAlive: boolean }[]>
  /** Include local quarantine fallbacks in the restart impact count. */
  countFallbackSessions: () => number
}

const defaultDependencies: Dependencies = {
  inspect: () =>
    inspectDaemonHostImage(readDaemonPidRecord(getDaemonPidPath(getDaemonRuntimeDir()))),
  restart: (expectedDaemonPid) => restartDaemon({ expectedDaemonPid }),
  listSessions: async () => {
    const provider = getDaemonProvider()
    return provider ? getCurrentDaemonAdapter(provider).listSessions() : []
  },
  countFallbackSessions: () => {
    const provider = getDaemonProvider()
    return provider instanceof DegradedDaemonPtyProvider
      ? provider.getSessionIdsRoutedTo('fallback').length
      : 0
  }
}

export function createSeveredDaemonController(
  dependencies: Dependencies = defaultDependencies
): SeveredDaemonController {
  return {
    countLiveSessions: async () => {
      try {
        const daemonSessions = (await dependencies.listSessions()).filter(
          (session) => session.isAlive
        ).length
        return daemonSessions + dependencies.countFallbackSessions()
      } catch {
        return null
      }
    },
    restart: async (expected) => restartVerifiedSeveredDaemon(expected, dependencies)
  }
}

async function restartVerifiedSeveredDaemon(
  expected: SeveredDaemonIncarnation,
  dependencies: Dependencies
): Promise<SeveredDaemonRestartResult> {
  const current = dependencies.inspect()
  if (current.verdict === 'unknown') {
    return { status: 'refused', reason: 'unverifiable' }
  }
  if (
    current.pid === null ||
    !current.linuxStartTicks ||
    !current.bootId ||
    !isSameIncarnation(
      { pid: current.pid, linuxStartTicks: current.linuxStartTicks, bootId: current.bootId },
      expected
    )
  ) {
    clearSeveredDaemon()
    return { status: 'refused', reason: 'replaced' }
  }
  const { killedCount } = await dependencies.restart(expected.pid)
  clearSeveredDaemon()
  return { status: 'restarted', killedCount }
}

export function hasSeveredDaemonBeenReplaced(
  pidPath: string,
  inspect: (pidPath: string) => ReturnType<typeof inspectDaemonHostImage> = (path) =>
    inspectDaemonHostImage(readDaemonPidRecord(path))
): boolean {
  const severed = getSeveredDaemon()
  if (!severed) {
    return true
  }
  const current = inspect(pidPath)
  if (
    current.verdict === 'unknown' ||
    current.verdict === 'severed' ||
    current.pid === null ||
    !current.linuxStartTicks ||
    !current.bootId ||
    isSameIncarnation(
      { pid: current.pid, linuxStartTicks: current.linuxStartTicks, bootId: current.bootId },
      severed
    )
  ) {
    return false
  }
  clearSeveredDaemon()
  return true
}
