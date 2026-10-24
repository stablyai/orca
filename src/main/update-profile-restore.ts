import { copyFile, lstat, mkdir, open, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { snapshotFileHash, createPrivateSnapshotDirectory } from './update-snapshot-file'

const Manifest = z.object({
  format: z.literal(1),
  version: z.string(),
  createdAt: z.string(),
  entries: z.array(
    z
      .object({
        path: z.string().min(1),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        link: z.string().optional(),
        directory: z.literal(true).optional()
      })
      .refine(
        (entry) =>
          [entry.sha256, entry.link, entry.directory].filter((value) => value !== undefined)
            .length === 1
      )
  )
})

function pathIdentity(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function containedPath(root: string, path: string): string {
  if (
    isAbsolute(path) ||
    path.includes('\0') ||
    path
      .split(/[\\/]/)
      .some((part) => part === '..' || (process.platform === 'win32' && part.includes(':')))
  ) {
    throw new Error('Unsafe backup path')
  }
  const result = resolve(root, path)
  const rel = relative(root, result)
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Unsafe backup path')
  }
  return result
}

/** Restore into a new directory only; never overwrite or reset the user's current profile. */
export async function restoreUpdateProfileSnapshot(
  backup: string,
  destination: string
): Promise<void> {
  const manifest = Manifest.parse(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')))
  const data = await realpath(join(backup, 'data'))
  const target = resolve(destination)
  const paths = new Set<string>()
  const links = manifest.entries
    .filter((entry) => entry.link !== undefined)
    .map((entry) => pathIdentity(containedPath(target, entry.path)))
  for (const entry of manifest.entries) {
    const output = containedPath(target, entry.path)
    if (links.some((link) => pathIdentity(output).startsWith(`${link}${sep}`))) {
      throw new Error('Backup link cannot be an ancestor of another entry')
    }
    const identity = pathIdentity(output)
    if (paths.has(identity)) {
      throw new Error('Duplicate backup path')
    }
    paths.add(identity)
    if (entry.sha256) {
      const input = containedPath(data, entry.path)
      const actual = await realpath(input)
      if (actual !== data && !actual.startsWith(`${data}${sep}`)) {
        throw new Error('Backup file escapes data directory')
      }
      if (!(await lstat(input)).isFile() || (await snapshotFileHash(input)) !== entry.sha256) {
        throw new Error('Backup checksum mismatch')
      }
    }
  }
  // Refuse existing destinations, including empty directories and symlinks.
  await createPrivateSnapshotDirectory(target)
  for (const entry of manifest.entries.filter((entry) => entry.directory)) {
    await mkdir(containedPath(target, entry.path), { recursive: true, mode: 0o700 })
  }
  for (const entry of manifest.entries.filter((entry) => entry.sha256)) {
    const output = containedPath(target, entry.path)
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await copyFile(containedPath(data, entry.path), output)
    if ((await snapshotFileHash(output)) !== entry.sha256) {
      throw new Error('Restored file checksum mismatch')
    }
    const file = await open(output, 'r+')
    try {
      const sourceMode = (await lstat(containedPath(data, entry.path))).mode
      await file.chmod(0o600 | (sourceMode & 0o100))
      await file.sync()
    } finally {
      await file.close()
    }
  }
  // Links are installed last so they cannot redirect restored file writes.
  for (const entry of manifest.entries) {
    if (entry.link !== undefined) {
      const output = containedPath(target, entry.path)
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      await symlink(entry.link, output)
    }
  }
}
