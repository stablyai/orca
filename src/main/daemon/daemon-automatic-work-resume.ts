import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus
} from '../../shared/host-spawn-admission'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'

type LocalDaemons = { current: DaemonPtyAdapter; legacy: readonly DaemonPtyAdapter[] }

/** The daemons behind the local provider; null for the in-process fallback, which has no gate. */
function localDaemons(provider: IPtyProvider): LocalDaemons | null {
  if (provider instanceof DaemonPtyAdapter) {
    return { current: provider, legacy: [] }
  }
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return { current: provider.getCurrentAdapter(), legacy: provider.getLegacyAdapters() }
  }
  return null
}

export async function getLocalAutomaticWorkStatus(
  provider: IPtyProvider
): Promise<AutomaticWorkStatus | null> {
  return (await localDaemons(provider)?.current.getAutomaticWorkStatus()) ?? null
}

/**
 * Each protocol generation keeps its own run marker, so a pause can sit on a daemon kept
 * running across an update too. The current daemon's answer is the one reported; an older
 * daemon that cannot be reached keeps its pause until it is retired.
 */
export async function resumeLocalAutomaticWork(
  provider: IPtyProvider
): Promise<AutomaticWorkResumeOutcome> {
  const daemons = localDaemons(provider)
  if (!daemons) {
    return null
  }
  const [current] = await Promise.allSettled([
    daemons.current.resumeAutomaticWork(),
    ...daemons.legacy.map((adapter) => adapter.resumeAutomaticWork())
  ])
  if (current.status === 'rejected') {
    throw current.reason
  }
  return current.value
}
