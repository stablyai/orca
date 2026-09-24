import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { renameDurableSync } from '../../durable-file-write'
import { profileStateJsonExportPath } from './profile-state-export-path'

/** An existing revision must never be replaced with different content. */
export function writeVersionedProfileStateExport(
  dataFile: string,
  writeExport: (targetPath: string) => number
): number | undefined {
  const stagingPath = `${dataFile}.sqlite-export.pending.${process.pid}.${Date.now()}.tmp`
  let published = false
  try {
    const revision = writeExport(stagingPath)
    if (revision === 0) {
      rmSync(stagingPath, { force: true })
      published = true
      return undefined
    }
    const targetPath = profileStateJsonExportPath(dataFile, revision)
    mkdirSync(dirname(targetPath), { recursive: true })
    if (existsSync(targetPath)) {
      const staged = readFileSync(stagingPath)
      const existing = readFileSync(targetPath)
      if (!staged.equals(existing)) {
        throw new Error(
          `Profile state export revision ${revision} already exists with different content`
        )
      }
      rmSync(stagingPath, { force: true })
    } else {
      renameDurableSync(stagingPath, targetPath)
    }
    published = true
    return revision
  } finally {
    if (!published) {
      rmSync(stagingPath, { force: true })
    }
  }
}
