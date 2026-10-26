import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { ensureOwnedPrivateDir } from '../daemon/daemon-socket-endpoint-path'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

// Why: children bind sockets under TMPDIR; the reported MCP proxy names run 43-46 bytes.
export const ACP_SOCKET_NAME_BUDGET = 56
const RUN_FOLDER_SUBPATH = '/run-XXXXXX/'

export function acpRunRootFitsSocket(root: string, os: 'linux' | 'darwin'): boolean {
  return unixSocketPathFits(`${root}${RUN_FOLDER_SUBPATH}${'x'.repeat(ACP_SOCKET_NAME_BUDGET)}`, os)
}

/** The data-folder root already names the agent, so one hash keeps the short path independent of it. */
export function acpShortTempRoot(args: {
  shortBase: string
  uid: number
  dataRoot: string
}): string {
  const hash = createHash('sha256').update(args.dataRoot).digest('hex').slice(0, 8)
  return join(args.shortBase, `oacp-${args.uid}`, hash)
}

/**
 * Keep the run folder inside Orca's data folder, unless a socket under it would exceed `sun_path`.
 * Then use a shorter per-user folder in /tmp, keyed by the data-folder root so Orca copies never wipe each other.
 */
export function resolveAcpTempRoot(args: {
  dataDirectory: string
  agent: string
  logger?: StructuredAgentSessionLogger
  platform?: NodeJS.Platform
  uid?: number | null
  shortBase?: string
}): string {
  const { dataDirectory, agent, logger, platform = process.platform, shortBase = '/tmp' } = args
  const uid = args.uid === undefined ? (process.getuid?.() ?? null) : args.uid
  const dataRoot = join(dataDirectory, 'acp-temp', agent)
  // Windows has no /tmp; its long data folders keep their current behavior.
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  if (!os || uid === null || acpRunRootFitsSocket(dataRoot, os)) {
    return dataRoot
  }
  const shortRoot = acpShortTempRoot({ shortBase, uid, dataRoot })
  // Why: even a short root that misses the budget still fits the usual socket names; a longer one only hurts.
  if (Buffer.byteLength(shortRoot) >= Buffer.byteLength(dataRoot)) {
    return dataRoot
  }
  const owner = join(shortBase, `oacp-${uid}`)
  try {
    ensureOwnedPrivateDir(owner, uid)
  } catch (error) {
    logger?.warn('ACP agent temp folder kept in the data folder', {
      scope: 'acp-temp',
      owner,
      error
    })
    return dataRoot
  }
  return shortRoot
}
