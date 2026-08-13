import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { toWindowsWslPath } from '../../shared/wsl-paths'

export type AgentSessionRulesHostContext = {
  /** Non-null selects the SSH filesystem provider registered for this connection; null/undefined writes locally. */
  connectionId?: string | null
  /** Resolved local WSL distro whose Linux filesystem is writable through its Windows UNC share. */
  wslDistro?: string | null
}

const REMOTE_AGENT_SESSION_RULES_TEMP_DIR = '/tmp'

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

function rulesFileName(rulesText: string): string {
  const hash = createHash('sha256').update(rulesText).digest('hex').slice(0, 16)
  return `orca-agent-session-rules-${hash}-${randomUUID()}.md`
}

/**
 * Writes global session rules text to a file on the host that will actually run the
 * CLI, returning its path for `--append-system-prompt-file`-style flags. Returns null
 * (no file written) when rulesText is empty, so callers can skip the flag entirely.
 */
export async function ensureAgentSessionRulesFile(
  rulesText: string,
  hostContext: AgentSessionRulesHostContext
): Promise<string | null> {
  if (!rulesText) {
    return null
  }
  const fileName = rulesFileName(rulesText)

  if (hostContext.connectionId) {
    const provider = requireSshFilesystemProvider(hostContext.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_AGENT_SESSION_RULES_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    if (!provider.writePrivateFileBase64) {
      throw new Error('Remote private file writes are unavailable')
    }
    await provider.writePrivateFileBase64(remotePath, Buffer.from(rulesText).toString('base64'))
    return remotePath
  }

  if (hostContext.wslDistro) {
    const linuxPath = path.posix.join(REMOTE_AGENT_SESSION_RULES_TEMP_DIR, fileName)
    const hostPath = toWindowsWslPath(linuxPath, hostContext.wslDistro)
    await fs.writeFile(hostPath, rulesText, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    // Why: the Windows host writes through UNC, but the launched WSL process must receive a Linux path.
    return linuxPath
  }

  const localPath = path.join(app.getPath('temp'), fileName)
  await fs.writeFile(localPath, rulesText, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  return localPath
}
