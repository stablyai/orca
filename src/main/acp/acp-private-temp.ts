// Stdio children cannot reattach after a host restart, so stale temp folders can be cleared.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveAcpTempRoot } from './acp-temp-root'
import type { AcpStructuredConnection, ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const wipes = new Map<string, Promise<void>>()

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

export async function acpPrivateTempConnect<
  Connection extends Pick<AcpStructuredConnection, 'onExit'> = AcpStructuredConnection
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'dataDirectory' | 'logger'> & {
    connect: ConnectAcpAgent<Connection>
  },
  closedBeforeSpawn: () => void
): Promise<ConnectAcpAgent<Connection>> {
  const dataRoot = join(deps.dataDirectory, 'acp-temp', deps.spec.agent)
  const root = await resolveAcpTempRoot({
    dataDirectory: deps.dataDirectory,
    agent: deps.spec.agent,
    logger: deps.logger
  })
  if (root !== dataRoot) {
    // Why: runs before the short root existed left their folders (about 1 GB each) in the data folder.
    await wipeRootOnce(dataRoot, deps.logger)
  }
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
