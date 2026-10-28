// Stdio children cannot reattach after a host restart, so stale temp folders can be cleared.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { ensureOwnedPrivateDir } from '../daemon/daemon-socket-endpoint-path'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredConnection, ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const wipes = new Map<string, Promise<void>>()
// Why: agent children bind sockets under TMPDIR; reported MCP proxy names run 43-46 bytes.
const SOCKET_UNDER_RUN_FOLDER = `/run-XXXXXX/${'x'.repeat(56)}`

function removeFolder(path: string, logger?: StructuredAgentSessionLogger): Promise<void> {
  return rm(path, { recursive: true, force: true }).catch((error: unknown) =>
    logger?.warn('ACP agent temp folder not removed', { scope: 'acp-temp', path, error })
  )
}

function wipeRootOnce(root: string, logger?: StructuredAgentSessionLogger): Promise<void> {
  let wipe = wipes.get(root)
  if (!wipe) {
    wipe = removeFolder(root, logger)
    wipes.set(root, wipe)
  }
  return wipe
}

/** Clear crash leftovers on first use of a root, then isolate each process in a new folder. */
export async function acpRunFolder(
  root: string,
  logger?: StructuredAgentSessionLogger
): Promise<{ path: string; remove(): Promise<void> }> {
  await wipeRootOnce(root, logger)
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, 'run-'))
  return { path, remove: () => removeFolder(path, logger) }
}

/** The data root, or a private /tmp folder when a socket under a run folder would overflow sun_path. */
function acpTempRoot(dataRoot: string, logger?: StructuredAgentSessionLogger): string {
  const uid = process.getuid?.()
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  if (uid === undefined || unixSocketPathFits(dataRoot + SOCKET_UNDER_RUN_FOLDER, os)) {
    return dataRoot
  }
  const owner = `/tmp/oacp-${uid}`
  try {
    ensureOwnedPrivateDir(owner, uid)
  } catch (error) {
    logger?.warn('ACP agent temp folder kept in the data folder', { scope: 'acp-temp', error })
    return dataRoot
  }
  // Why: a hash keeps the path short and stops two Orca copies wiping each other's runs.
  return join(owner, createHash('sha256').update(dataRoot).digest('hex').slice(0, 8))
}

export async function acpPrivateTempConnect<
  Connection extends Pick<AcpStructuredConnection, 'onExit'> = AcpStructuredConnection
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'dataDirectory' | 'logger'> & {
    connect: ConnectAcpAgent<Connection>
  },
  closedBeforeSpawn: () => void
): Promise<ConnectAcpAgent<Connection>> {
  const dataRoot = join(deps.dataDirectory, 'acp-temp', deps.spec.agent)
  const root = acpTempRoot(dataRoot, deps.logger)
  // Why: runs from before the /tmp root left their folders (about 1 GB each) in the data root.
  await wipeRootOnce(dataRoot, deps.logger)
  const folder = await acpRunFolder(root, deps.logger).catch((error: unknown) => {
    throw new AgentSessionPreSpawnError(error)
  })
  return (launch, options) => {
    try {
      closedBeforeSpawn()
      const env = { ...launch.env, TMPDIR: folder.path, TEMP: folder.path, TMP: folder.path }
      const connection = deps.connect({ ...launch, env }, options)
      connection.onExit(() => void folder.remove())
      return connection
    } catch (error) {
      void folder.remove()
      throw error
    }
  }
}
