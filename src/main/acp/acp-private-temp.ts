// Stdio children cannot reattach after a host restart, so stale temp folders can be cleared.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPreparationFailure } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredConnection, ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const wipes = new Map<string, Promise<void>>()

/** Clear crash leftovers on first use of a root, then isolate each process in a new folder. */
export async function acpRunFolder(
  root: string,
  logger?: StructuredAgentSessionLogger
): Promise<{ path: string; remove(): Promise<void> }> {
  const remove = (path: string): Promise<void> =>
    rm(path, { recursive: true, force: true }).catch((error: unknown) =>
      logger?.warn('ACP agent temp folder not removed', { scope: 'acp-temp', path, error })
    )
  let wipe = wipes.get(root)
  if (!wipe) {
    wipe = remove(root)
    wipes.set(root, wipe)
  }
  await wipe
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, 'run-'))
  return { path, remove: () => remove(path) }
}

export async function acpPrivateTempConnect<
  Connection extends Pick<AcpStructuredConnection, 'onExit'> = AcpStructuredConnection
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'dataDirectory' | 'logger'> & {
    connect: ConnectAcpAgent<Connection>
  },
  closedBeforeSpawn: () => void
): Promise<ConnectAcpAgent<Connection>> {
  const folder = await acpRunFolder(
    join(deps.dataDirectory, 'acp-temp', deps.spec.agent),
    deps.logger
  ).catch((error: unknown) => {
    throw launchPreparationFailure(error)
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
