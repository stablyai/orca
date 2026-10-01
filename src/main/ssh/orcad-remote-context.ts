/** Everything a managed-orcad operation needs to know about one SSH host before it acts. */
import type { ServerTarget } from '../../shared/node-runtime-pin'
import type { SshTarget } from '../../shared/ssh-types'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import type { SshConnection } from './ssh-connection'
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
  serverTarget: ServerTarget
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
  // Why first: every lifecycle step after this is POSIX-only, so refuse before probing further.
  assertPosixOrcadHost(host)
  const remote = { conn: connection, host, signal }
  const remoteHome = normalizeRemoteHome(
    await execOrcadRemote(remote, readRemoteHomeCommand(host)),
    host
  )
  if (!validateRemoteHome(remoteHome, host)) {
    throw new Error(`Remote home is not a valid path: ${remoteHome.slice(0, 100)}`)
  }
  const serverTarget = await resolveOrcadDeploymentTarget({ conn: connection, host, signal })
  const activationRecord = await readOrcadActivationRecord({ ...remote, remoteHome })
  return {
    activationRecord,
    serverTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir: joinRemotePath(host, remoteHome, '.orca')
  }
}
