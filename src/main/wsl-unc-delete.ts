import { execFile } from 'node:child_process'
import { parseWslPath } from './wsl'

/**
 * Delete a file/directory that lives on a WSL distro's Linux filesystem,
 * addressed from Windows via a \\wsl.localhost\<distro>\... (or legacy
 * \\wsl$\...) UNC path.
 *
 * Why: Electron's shell.trashItem() cannot move a WSL UNC item to a Recycle
 * Bin — the WSL virtual volume has none — so it throws and the delete fails
 * (issue #6415). For these paths we run `rm` inside the distro via wsl.exe,
 * which performs a true delete on the Linux fs and honors Linux permissions.
 *
 * Returns false when the path is not a WSL UNC path, so callers can fall back
 * to the normal local-trash behavior (we must never hard-delete a normal local
 * file that currently goes to the Recycle Bin).
 */
export async function tryDeleteWslUncPath(
  targetPath: string,
  options: { recursive?: boolean } = {}
): Promise<boolean> {
  const info = parseWslPath(targetPath)
  if (!info) {
    return false
  }

  // Why: `rm -f` makes the delete idempotent — a missing file is success,
  // matching the ENOENT-swallowing semantics of the trash path. `--` stops
  // flag parsing so a Linux path that starts with `-` can't be read as an
  // option. `-r` is added only for directory deletes the renderer confirmed.
  const flags = options.recursive ? '-rf' : '-f'
  await execFileWsl(info.distro, ['rm', flags, '--', info.linuxPath])
  return true
}

function execFileWsl(distro: string, command: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', ...command],
      // Why: a generous bound so deleting a large directory tree on the WSL fs
      // doesn't abort mid-delete, while still capping a wedged wsl.exe.
      { encoding: 'utf-8', timeout: 30000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(wslDeleteError(error, stderr))
          return
        }
        resolve()
      }
    )
  })
}

function wslDeleteError(error: Error, stderr: string): Error {
  const detail = stderr.trim()
  if (!detail) {
    return error
  }
  return new Error(`Failed to delete WSL path: ${detail}`)
}
