import { SCHEMA_VERSION } from '../../shared/constants'
import {
  getLocalBuildCompatibilityError,
  type LocalBuildCompatibility
} from '../../shared/local-build-compatibility'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import { getDaemonProvider } from '../daemon/daemon-init'
import { getLocalPtyProvider } from '../ipc/pty'
import { LocalPtyProvider } from '../providers/local-pty-provider'

export type LocalBuildCompatibilityResult = {
  liveTerminalCount: number
  liveDaemonProtocols: number[]
}

async function getLiveDaemonProtocols(): Promise<{
  count: number
  protocols: number[]
}> {
  const provider = getDaemonProvider()
  if (!provider) {
    const localProvider = getLocalPtyProvider()
    if (!(localProvider instanceof LocalPtyProvider)) {
      throw new Error('Could not verify terminal preservation. Restart Orca and try again.')
    }
    const localProcesses = await localProvider.listProcesses()
    if (localProcesses.length > 0) {
      throw new Error(
        'Local build switching is blocked while non-persistent fallback terminals are running.'
      )
    }
    throw new Error('The terminal service is still starting. Try again in a moment.')
  }
  if (provider instanceof DegradedDaemonPtyProvider) {
    throw new Error(
      'Local build switching is blocked while the terminal service is in fallback mode. Restart Orca first.'
    )
  }
  const adapters =
    provider instanceof DaemonPtyRouter ? provider.getAllAdapters() : [provider as DaemonPtyAdapter]
  const sessions = await Promise.all(
    adapters.map(async (adapter) => ({
      protocol: adapter.protocolVersion,
      count: (await adapter.listSessions()).length
    }))
  )
  return {
    count: sessions.reduce((sum, entry) => sum + entry.count, 0),
    protocols: sessions.filter((entry) => entry.count > 0).map((entry) => entry.protocol)
  }
}

export async function assertLocalBuildCompatibility(
  target: LocalBuildCompatibility
): Promise<LocalBuildCompatibilityResult> {
  const stateCompatibilityError = getLocalBuildCompatibilityError(target, SCHEMA_VERSION, [])
  if (stateCompatibilityError) {
    throw new Error(stateCompatibilityError)
  }
  const live = await getLiveDaemonProtocols()
  const compatibilityError = getLocalBuildCompatibilityError(target, SCHEMA_VERSION, live.protocols)
  if (compatibilityError) {
    throw new Error(compatibilityError)
  }
  return {
    liveTerminalCount: live.count,
    liveDaemonProtocols: [...new Set(live.protocols)].sort((left, right) => left - right)
  }
}
