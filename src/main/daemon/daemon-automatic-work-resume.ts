import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus
} from '../../shared/host-spawn-admission'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'

type LocalDaemons = { current: DaemonPtyAdapter; legacy: readonly DaemonPtyAdapter[] }

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

// Resume current and legacy generations; only the current result is authoritative.
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
