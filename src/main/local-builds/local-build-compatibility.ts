import { SCHEMA_VERSION } from '../../shared/constants'
import {
  getLocalBuildCompatibilityError,
  type LocalBuildCompatibility
} from '../../shared/local-build-compatibility'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { getDaemonProvider } from '../daemon/daemon-init'

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
    throw new Error(
      'The terminal service is unavailable. Retry starting it before switching builds.'
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
