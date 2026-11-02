// A temp folder of its own for each process of an agent whose temp files collide across processes,
// under Orca's locked data root. ACP children talk over stdio, so one left by an earlier host run
// can never be reattached: the host's first start of the agent clears the whole root.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredConnection, ConnectAcpAgent } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

const wipes = new Map<string, Promise<void>>()

/** `deps.connect`, giving the child a new folder as its temp and removing it once the child exits. */
export async function acpPrivateTempConnect<
  Connection extends Pick<AcpStructuredConnection, 'onExit'> = AcpStructuredConnection
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'dataDirectory' | 'logger'> & {
    connect: ConnectAcpAgent<Connection>
  },
  closedBeforeSpawn: () => void
): Promise<ConnectAcpAgent<Connection>> {
  const root = join(deps.dataDirectory, 'acp-temp', deps.spec.agent)
  // Best effort: Windows can hold a handle past the kill; the next host start clears what stays.
  const remove = (path: string): Promise<void> =>
    rm(path, { recursive: true, force: true }).catch((error: unknown) =>
      deps.logger?.warn('ACP agent temp folder not removed', { scope: 'acp-temp', path, error })
    )
  let wipe = wipes.get(root)
  if (!wipe) {
    wipe = remove(root)
    wipes.set(root, wipe)
  }
  await wipe
  const folder = await mkdir(root, { recursive: true })
    .then(() => mkdtemp(join(root, 'run-')))
    .catch((error: unknown) => {
      throw new AgentSessionPreSpawnError(error)
    })
  return (launch, options) => {
    try {
      closedBeforeSpawn()
      const env = { ...launch.env, TMPDIR: folder, TEMP: folder, TMP: folder }
      const connection = deps.connect({ ...launch, env }, options)
      connection.onExit(() => void remove(folder))
      return connection
    } catch (error) {
      void remove(folder)
      throw error
    }
  }
}
