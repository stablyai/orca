import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, win32 } from 'node:path'
import { isDescendantOrEqual } from '../ipc/filesystem/filesystem-path-containment'
import {
  parseWslUncPath,
  toLinuxPath,
  toWindowsWslPath,
  toWindowsWslUncPath
} from '../../shared/wsl-paths'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  TERMINAL_KITTY_FILE_MAX_BYTES,
  type TerminalKittyFileRequest,
  type TerminalKittyFileResult
} from '../../shared/terminal-kitty-file'
import { kittyTemporaryRoots } from './terminal-kitty-temporary-roots'

export async function readTerminalKittyFile(
  request: TerminalKittyFileRequest,
  owner: { workspacePath: string | null; wslDistro: string | null },
  signal?: AbortSignal
): Promise<TerminalKittyFileResult> {
  signal?.throwIfAborted()
  const path = resolveKittyFilePath(request.path, owner.wslDistro)
  const workspacePath =
    owner.workspacePath && owner.wslDistro
      ? toWindowsWslPath(toLinuxPath(owner.workspacePath), owner.wslDistro)
      : owner.workspacePath
  const [canonical, workspaceRoot, tempRoots] = await Promise.all([
    realpath(path),
    workspacePath ? realpath(workspacePath) : null,
    kittyTemporaryRoots(
      owner.wslDistro ? toWindowsWslUncPath('/', owner.wslDistro) : (workspacePath ?? '')
    )
  ])
  const roots = workspaceRoot ? [workspaceRoot, ...tempRoots] : tempRoots
  if (!roots.some((root) => kittyFileInsideRoot(root, canonical, owner.wslDistro !== null))) {
    throw new Error('Kitty image file is outside this terminal workspace and temporary folders')
  }
  const expected = await lstat(canonical)
  if (!expected.isFile() || expected.nlink !== 1) {
    throw new Error('Kitty image must be a regular file without hard links')
  }
  signal?.throwIfAborted()
  const flags =
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  const handle = await open(canonical, flags)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      (await realpath(path)) !== canonical
    ) {
      throw new Error('Kitty image file changed before reading')
    }
    const { buffer } = await readNodeFileHandleWithinLimit(handle, TERMINAL_KITTY_FILE_MAX_BYTES, {
      regularFileOnly: true,
      signal,
      window: { offset: request.offset ?? 0, length: request.length }
    })
    signal?.throwIfAborted()
    return { base64: buffer.toString('base64') }
  } finally {
    await handle.close()
  }
}

function kittyFileInsideRoot(root: string, path: string, wslOwned: boolean): boolean {
  const rootWsl = process.platform === 'win32' ? parseWslUncPath(root) : null
  const pathWsl = process.platform === 'win32' ? parseWslUncPath(path) : null
  if (rootWsl || pathWsl) {
    return Boolean(
      rootWsl &&
      pathWsl &&
      rootWsl.distro.toLowerCase() === pathWsl.distro.toLowerCase() &&
      (pathWsl.linuxPath === rootWsl.linuxPath ||
        pathWsl.linuxPath.startsWith(`${rootWsl.linuxPath.replace(/\/$/, '')}/`))
    )
  }
  if (wslOwned && process.platform === 'win32') {
    const base = root.replace(/^[a-z]:/i, (drive) => drive.toUpperCase()).replace(/\\$/, '')
    const target = path.replace(/^[a-z]:/i, (drive) => drive.toUpperCase())
    return target === base || target.startsWith(`${base}\\`)
  }
  return isDescendantOrEqual(path, root)
}

export function resolveKittyFilePath(path: string, wslDistro: string | null): string {
  if (!path || path.length > 4096 || path.includes('\0')) {
    throw new Error('Invalid Kitty image file path')
  }
  if (wslDistro) {
    if (process.platform !== 'win32' || !/^\/(?!\/)/.test(path) || path.includes('\\')) {
      throw new Error('Kitty image path must belong to this terminal WSL distro')
    }
    const mapped = toWindowsWslPath(path, wslDistro)
    return parseWslUncPath(mapped) ? mapped : resolveKittyFilePath(mapped, null)
  }
  if (
    !(process.platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)) ||
    (process.platform === 'win32' &&
      (!/^[a-z]:[/\\]/i.test(path) ||
        path.slice(2).includes(':') ||
        path
          .split(/[/\\]/)
          .some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))
  ) {
    throw new Error('Kitty image path must be an absolute local file path')
  }
  return path
}
