/**
 * What every managed-orcad operation on a Windows host needs before its first host op: this
 * client's pinned node.exe in the runtime store, and the host script it runs.
 *
 * Both are idempotent: a present runtime costs one probe and nothing is uploaded, and the host
 * script is content-addressed, so rewriting it changes nothing a running orcad depends on.
 */
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import { installOrcadWindowsHostScript, orcadRemoteBaseDir } from './orcad-remote-windows-node'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export async function prepareWindowsOrcadHost(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  serverTarget: NodeRuntimeTarget
  signal?: AbortSignal
}): Promise<void> {
  const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
  await ensureRemoteOrcadNodeRuntime({
    conn: options.conn,
    host: options.host,
    // Only its parent is read: the runtime store sits beside the slots.
    slotDir: joinRemotePath(options.host, baseDir, 'orcad-host'),
    target: options.serverTarget,
    archivePath: () =>
      materializeNodeRuntimeArchive(
        options.serverTarget,
        join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
        { signal: options.signal }
      ),
    signal: options.signal
  })
  await installOrcadWindowsHostScript(options, baseDir)
}
