import { mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

/** Windows junction (no privilege needed) or a POSIX link relative to the real parent. */
export async function createNativeSkillAlias(
  canonicalPath: string,
  destinationPath: string
): Promise<void> {
  const parent = dirname(destinationPath)
  await mkdir(parent, { recursive: true })
  if (process.platform === 'win32') {
    await symlink(resolve(canonicalPath), destinationPath, 'junction')
    return
  }
  const realParent = await realpath(parent).catch(() => resolve(parent))
  const realCanonical = await realpath(canonicalPath)
  await symlink(relative(realParent, realCanonical), destinationPath, 'dir')
}
