// Host discovery reads conventional shell files without executing their contents.
import { access, constants, open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { resolveClaudeCommand, resolveCodexCommand } from '../../shared/node-cli-command-resolution'
import type { ProfileAgent } from '../../shared/agent-launch-profile'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ProfileAliasSource } from '../agent-profile-discovery/literal-alias'

export type ProfileHostContext = {
  hostId: ExecutionHostId
  platform: NodeJS.Platform
  isWsl: boolean
  home: string
  shell: string
  pathEnv?: string
}
export function createProfileExecutableDetector(
  host: ProfileHostContext
): (agent: ProfileAgent) => Promise<string> {
  const options = { platform: host.platform, homePath: host.home, pathEnv: host.pathEnv }
  return async (agent) =>
    agent === 'claude' ? resolveClaudeCommand(options) : resolveCodexCommand(options)
}
export async function readConventionalProfileAliases(
  host: ProfileHostContext
): Promise<ProfileAliasSource[]> {
  const shell = basename(host.shell)
  const files =
    shell === 'zsh'
      ? ['.zshrc', '.zsh_aliases']
      : shell === 'bash'
        ? ['.bashrc', '.bash_profile', '.bash_aliases']
        : []
  const sources: ProfileAliasSource[] = []
  for (const file of files) {
    const name = join(host.home, file)
    let handle
    try {
      handle = await open(name, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue
      }
      throw new Error('Shell alias file is unreadable. Choose a configuration folder.')
    }
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error('unsupported file')
      }
      const bytes = Buffer.alloc(1024 * 1024 + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null)
        if (!result.bytesRead) {
          break
        }
        length += result.bytesRead
      }
      if (length > 1024 * 1024) {
        throw new Error('oversize file')
      }
      sources.push({ name, content: bytes.subarray(0, length).toString('utf8') })
    } catch {
      throw new Error('Shell alias file cannot be safely inspected. Choose a configuration folder.')
    } finally {
      await handle.close()
    }
  }
  return sources
}

export async function resolveProfileExecutable(
  detected: string
): Promise<{ detected: string; canonical: string }> {
  if (!isAbsolute(detected)) {
    throw new Error('Supported agent executable was not detected. Install the agent first.')
  }
  try {
    const canonical = await realpath(detected)
    if (!(await stat(canonical)).isFile()) {
      throw new Error('not a file')
    }
    await access(canonical, constants.X_OK)
    return { detected, canonical }
  } catch {
    throw new Error('Detected agent executable is unavailable.')
  }
}
