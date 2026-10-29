import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { parseWslPath, toWindowsWslPath } from '../wsl'

export async function kittyTemporaryRoots(worktreePath: string): Promise<string[]> {
  const roots = new Set<string>([tmpdir()])
  if (process.platform !== 'win32') {
    roots.add('/tmp')
    roots.add('/private/tmp')
  }
  const wsl = parseWslPath(worktreePath)
  if (wsl) {
    roots.add(toWindowsWslPath('/tmp', wsl.distro))
  }
  const canonicalRoots = await Promise.all(
    Array.from(roots).map((root) => realpath(root).catch(() => root))
  )
  return Array.from(new Set([...roots, ...canonicalRoots]))
}
