import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

// Why: children bind sockets under TMPDIR; the reported MCP proxy names run 43-46 bytes.
export const ACP_SOCKET_NAME_BUDGET = 56
const RUN_FOLDER_SUBPATH = '/run-XXXXXX/'

export function acpRunRootFitsSocket(root: string, os: 'linux' | 'darwin'): boolean {
  return unixSocketPathFits(`${root}${RUN_FOLDER_SUBPATH}${'x'.repeat(ACP_SOCKET_NAME_BUDGET)}`, os)
}

function isExistingFolderError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

// Why: a /tmp folder another user created first must never hold an agent's temp files.
async function prepareOwnedFolder(path: string, uid: number): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!isExistingFolderError(error)) {
        throw error
      }
    })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.uid !== uid) {
      return false
    }
    if ((stat.mode & 0o077) !== 0) {
      await chmod(path, 0o700)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Keep the run folder inside Orca's data folder, unless a socket under it would exceed `sun_path`.
 * Then use a short per-user folder in /tmp, keyed by the data folder so Orca copies never wipe each other.
 */
export async function resolveAcpTempRoot(args: {
  dataDirectory: string
  agent: string
  logger?: StructuredAgentSessionLogger
  platform?: NodeJS.Platform
  uid?: number | null
  shortBase?: string
}): Promise<string> {
  const { dataDirectory, agent, logger, platform = process.platform, shortBase = '/tmp' } = args
  const uid = args.uid === undefined ? (process.getuid?.() ?? null) : args.uid
  const dataRoot = join(dataDirectory, 'acp-temp', agent)
  // Windows has no /tmp; its long data folders keep their current behavior.
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  if (!os || uid === null || acpRunRootFitsSocket(dataRoot, os)) {
    return dataRoot
  }
  const owner = join(shortBase, `oacp-${uid}`)
  const shortRoot = join(
    owner,
    createHash('sha256').update(dataDirectory).digest('hex').slice(0, 6),
    agent
  )
  if (!acpRunRootFitsSocket(shortRoot, os)) {
    return dataRoot
  }
  if (!(await prepareOwnedFolder(owner, uid))) {
    logger?.warn('ACP agent temp folder kept in the data folder', { scope: 'acp-temp', owner })
    return dataRoot
  }
  return shortRoot
}
