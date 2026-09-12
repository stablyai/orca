import { lstatSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

function hasEndpointEvidence(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    // Unreadable evidence must keep the generation represented as unverifiable.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function createDaemonRecoveryProvider(
  runtimeDir: string,
  historyPath: string
): DaemonPtyRouter {
  const create = (protocolVersion: number): DaemonPtyAdapter =>
    new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
      tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
      pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
      profileScope: runtimeDir,
      runtimeDir,
      historyPath,
      protocolVersion,
      recoveryOnly: true
    })
  const legacy = PREVIOUS_DAEMON_PROTOCOL_VERSIONS.filter((version) =>
    [
      getDaemonPidPath(runtimeDir, version),
      getDaemonTokenPath(runtimeDir, version),
      ...(process.platform === 'win32' ? [] : [getDaemonSocketPath(runtimeDir, version)])
    ].some(hasEndpointEvidence)
  ).map(create)
  // Represent the current endpoint even when absent; missing contact is not an empty census.
  return new DaemonPtyRouter({ current: create(PROTOCOL_VERSION), legacy })
}
