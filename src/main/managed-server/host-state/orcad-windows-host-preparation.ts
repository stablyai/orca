// Stage pinned Node and a content-addressed host script so Windows operations share verified bytes without replacing running clients' code.
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteOrcadNodeRuntime } from '../install/orcad-remote-node-runtime'
import {
  installOrcadWindowsHostScript,
  orcadRemoteBaseDir
} from '../install/orcad-remote-windows-node'
import { materializeNodeRuntimeArchive } from '../../node-runtime/pinned-runtime-materializer'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export async function prepareWindowsOrcadHost(options: {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  serverTarget: NodeRuntimeTarget
  signal?: AbortSignal
}): Promise<void> {
  const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
  await ensureRemoteOrcadNodeRuntime({
    conn: options.conn,
    host: options.host,
    // The runtime store is a sibling of slots; only this synthetic slot's parent is used.
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
