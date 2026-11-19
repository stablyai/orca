import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeRollingFileBackup } from './rolling-file-backup'

// Windows refuses to rename over a read-only file, so a read-only backup blocked every later write.
it.skipIf(process.platform !== 'win32')(
  'keeps backing up after the source was read-only once',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-rolling-backup-'))
    const source = join(root, 'config.toml')
    const backup = `${source}.bak`
    try {
      writeFileSync(source, 'model = "first"\n')
      chmodSync(source, 0o444)
      writeRollingFileBackup(source, backup)
      chmodSync(source, 0o666)
      writeFileSync(source, 'model = "second"\n')

      writeRollingFileBackup(source, backup)

      expect(readFileSync(backup, 'utf-8')).toBe('model = "second"\n')
      expect(statSync(backup).mode & 0o200).toBe(0o200)
    } finally {
      chmodSync(source, 0o666)
      rmSync(root, { recursive: true, force: true })
    }
  }
)
