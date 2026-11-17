import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'

export async function bundledSkillTreeSignature(
  filesystem: BundledSkillFilesystem,
  path: string
): Promise<string> {
  const hash = createHash('sha256')
  const requireRead = <T>(value: T | null): T => {
    if (value === null) {
      throw Object.assign(new Error(`bundled-skill-unreadable: ${path}`), { code: 'EIO' })
    }
    return value
  }
  const visit = async (current: string, relative: string): Promise<void> => {
    const found = await filesystem.stat(current)
    const stats = requireRead(found?.kind === 'missing' ? null : found)
    hash.update(`${JSON.stringify([relative, stats.kind])}\n`)
    if (stats.kind === 'symlink') {
      hash.update(JSON.stringify(requireRead(await filesystem.readLink(current))))
    } else if (stats.kind === 'file') {
      const digest = filesystem.hashFile
        ? requireRead(await filesystem.hashFile(current))
        : createHash('sha256')
            .update(requireRead(await filesystem.readFile(current)))
            .digest('hex')
      hash.update(digest)
    } else if (stats.kind === 'directory') {
      const names = requireRead(await filesystem.listEntries(current)).map((entry) => entry.name)
      for (const name of names.sort()) {
        await visit(join(current, name), `${relative}/${name}`)
      }
    }
    hash.update('\0')
  }
  await visit(path, '.')
  return hash.digest('hex')
}
