/**
 * Why a WSL UNC path (`\\wsl.localhost\<distro>\…`) couldn't be opened, when Windows refused it.
 * Git then reports no repository, which sends the user looking in the wrong place: some sessions
 * can list a distro's `\home` and `\mnt` but get EPERM inside `\mnt\<drive>`.
 */
import { readdir } from 'node:fs/promises'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { wslHostsOptedIn } from './wsl-host-gate'

/** The message to show instead of "not a git repository"; null when access wasn't the problem. */
export async function describeWslUncAccessDenied(
  path: string,
  settings: { experimentalWslHosts?: boolean } | null | undefined,
  list: (path: string) => Promise<unknown> = readdir
): Promise<string | null> {
  // Opt-in (Stage 1): the renderer offers "add as folder" only on the usual "not a git repository"
  // text, which a user who hasn't turned WSL hosts on keeps.
  if (process.platform !== 'win32' || !wslHostsOptedIn(settings) || !parseWslUncPath(path)) {
    return null
  }
  try {
    await list(path)
    return null
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return code === 'EPERM' || code === 'EACCES'
      ? `Windows denied access to this WSL path: ${path}`
      : null
  }
}
