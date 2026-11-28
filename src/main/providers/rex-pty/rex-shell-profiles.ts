import { userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

export async function getRexShellProfiles(): Promise<{ name: string; path: string }[]> {
  const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh']
  const profiles = await Promise.all(
    candidates.map(async (path) => {
      try {
        await access(path, constants.X_OK)
        return { name: basename(path), path }
      } catch {
        return null
      }
    })
  )
  return profiles.filter((profile) => profile !== null)
}

export function resolveRexLaunchShell(override?: string): string {
  const shell =
    override || userInfo().shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  if (!isAbsolute(shell)) {
    throw new Error('Invalid default shell')
  }
  return shell
}
