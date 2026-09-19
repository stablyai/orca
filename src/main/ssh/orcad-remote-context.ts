import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import type { SshTarget } from '../../shared/ssh-types'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { detectRemoteOrcadTarget } from './orcad-remote-target-detection'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { readRemoteHomeCommand } from './ssh-remote-commands'
import {
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'

export type OrcadRemoteContext = {
  activationRecord: OrcadActivationRecord
  bunTarget: OrcadBunTarget
  connection: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  target: SshTarget
  userDataDir: string
}

export async function resolveOrcadRemoteContext(
  target: SshTarget,
  connection: SshConnection,
  signal?: AbortSignal
): Promise<OrcadRemoteContext> {
  const host = await detectRemoteHostPlatform(connection, { signal })
  if (!host) {
    throw new Error('This SSH host platform is not supported by managed orcad.')
  }
  const remoteHome = normalizeRemoteHome(
    await execCommand(connection, readRemoteHomeCommand(host), {
      wrapCommand: host.commandDialect !== 'powershell',
      signal
    }),
    host
  )
  if (!validateRemoteHome(remoteHome, host)) {
    throw new Error(`Remote home is not a valid path: ${remoteHome.slice(0, 100)}`)
  }
  const bunTarget = await detectRemoteOrcadTarget(connection, host, { signal })
  const activationRecord = await readOrcadActivationRecord({
    conn: connection,
    host,
    remoteHome,
    signal
  })
  return {
    activationRecord,
    bunTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir: joinRemotePath(host, remoteHome, '.orca')
  }
}
