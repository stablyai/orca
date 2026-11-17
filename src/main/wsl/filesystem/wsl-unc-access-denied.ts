/**
 * Why a WSL UNC path (`\\wsl.localhost\<distro>\…`) couldn't be opened, when Windows refused it.
 * Git then reports no repository, which sends the user looking in the wrong place: some sessions
 * can list a distro's `\home` and `\mnt` but get EPERM inside `\mnt\<drive>`.
 */
import { readdir } from 'node:fs/promises'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { wslHostsOptedIn } from '../host-lifecycle/wsl-host-gate'
import type { WslHostsSetting } from '../../../shared/remote-runtime/wsl-hosts/wsl-hosts-setting'

/** The message to show instead of "not a git repository"; null when access wasn't the problem. */
export async function describeWslUncAccessDenied(
  path: string,
  settings: WslHostsSetting | null | undefined,
  list: (path: string) => Promise<unknown> = readdir
): Promise<string | null> {
  // The renderer offers "add as folder" only on the usual "not a git repository" text, which a
  // user who turned WSL hosts off keeps.
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
