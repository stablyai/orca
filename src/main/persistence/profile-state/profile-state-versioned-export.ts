import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../shared/secure-file'
import { durableWriteTempPath, publishFileDurableSync } from '../../durable-file-write'
import { profileStateJsonExportPath } from './profile-state-export-path'

/** An existing revision must never be replaced with different content. */
export function writeVersionedProfileStateExport(
  dataFile: string,
  writeExport: (targetPath: string) => number
): number | undefined {
  const stagingPath = durableWriteTempPath(`${dataFile}.sqlite-export.pending`)
  try {
    const revision = writeExport(stagingPath)
    if (revision === 0) {
      return undefined
    }
    const targetPath = profileStateJsonExportPath(dataFile, revision)
    mkdirSync(dirname(targetPath), { recursive: true })
    if (!publishFileDurableSync(stagingPath, targetPath)) {
      const staged = readFileSync(stagingPath)
      const existing = readFileSync(targetPath)
      if (!staged.equals(existing)) {
        throw new Error(
          `Profile state export revision ${revision} already exists with different content`
        )
      }
      fsyncFileSync(targetPath)
      bestEffortFsyncDirectorySync(dirname(targetPath))
    }
    return revision
  } finally {
    rmSync(stagingPath, { force: true })
  }
}
