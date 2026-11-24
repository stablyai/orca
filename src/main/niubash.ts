import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isNiubashShell } from '../shared/niubash-shell'

type NiubashPathOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isExecutable?: (path: string) => boolean | Promise<boolean>
}

/** Only absolute PATH entries participate; a workspace-local niu must not shadow the shell. */
export async function resolveNiubashPath(options: NiubashPathOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const path = platform === 'win32' ? win32 : posix
  const pathValue = Object.entries(env).find(([key]) =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  )?.[1]
  const isExecutable =
    options.isExecutable ??
    (async (candidate: string): Promise<boolean> => {
      try {
        if (!(await stat(candidate)).isFile()) {
          return false
        }
        if (platform !== 'win32') {
          await access(candidate, constants.X_OK)
        }
        return true
      } catch {
        return false
      }
    })
  for (const entry of pathValue?.split(path.delimiter) ?? []) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!path.isAbsolute(directory)) {
      continue
    }
    const candidate = path.join(directory, platform === 'win32' ? 'niu.exe' : 'niu')
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

export async function resolveNiubashShellPath(shell: string): Promise<string> {
  if (!isNiubashShell(shell) || win32.isAbsolute(shell) || posix.isAbsolute(shell)) {
    return shell
  }
  const resolved = await resolveNiubashPath()
  if (!resolved) {
    throw new Error('Niubash was not found. Install niu and add it to PATH.')
  }
  return resolved
}
