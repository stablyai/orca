import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isNodeRuntimeTarget,
  type NodeRuntimeTarget,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import { ORCAD_SERVER_TARGET_FILENAME } from '../../shared/orcad-artifacts'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import { probeLinuxLibc, type GlibcVersion } from '../node-runtime/linux-libc-probe'
import { execCommand } from './remote-exec/remote-exec-command'
import type { RemoteHostPlatform } from './ssh-remote-platform'

type OrcadDeploymentTargetFacts = {
  target: ServerTarget
  /** The host's glibc, when the libc probe printed one; null on musl and non-Linux hosts. */
  glibc: GlibcVersion | null
}

export async function resolveOrcadDeploymentTargetFacts(options: {
  conn: RemoteInstallTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<OrcadDeploymentTargetFacts> {
  const { host } = options
  if (host.os !== 'linux') {
    return { target: `${host.os}-${host.arch}`, glibc: null }
  }
  const exec =
    options.exec ??
    ((command: string) => execCommand(options.conn, command, { signal: options.signal }))
  const { libc, glibc } = await probeLinuxLibc(exec)
  return {
    target: `linux-${host.arch}-${libc}`,
    glibc
  }
}

/** The runtime target an assembled bundle was built for, a compat one included. */
export function readOrcadBundleTarget(localOrcadDir: string): NodeRuntimeTarget {
  const recorded = readFileSync(join(localOrcadDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8').trim()
  if (!isNodeRuntimeTarget(recorded)) {
    throw new Error(`The orcad bundle names no known server target: ${recorded}`)
  }
  return recorded
}
