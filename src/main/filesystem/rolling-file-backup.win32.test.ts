import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeHooksJsonAsync } from '../agent-hooks/installation/configuration/hooks-json-write-async'
import { writeRollingFileBackup } from './rolling-file-backup'

// Windows refuses to rename over a read-only file, so a read-only backup blocked every later write.
describe.skipIf(process.platform !== 'win32')('read-only backups on Windows', () => {
  let root: string
  let source: string
  let backup: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-rolling-backup-'))
    source = join(root, 'config.toml')
    backup = `${source}.bak`
  })
  afterEach(() => {
    for (const path of [source, backup]) {
      try {
        chmodSync(path, 0o666)
      } catch {
        // Absent.
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps backing up after the source was read-only once', () => {
    writeFileSync(source, 'model = "first"\n')
    chmodSync(source, 0o444)
    writeRollingFileBackup(source, backup)
    expect(statSync(backup).mode & 0o200).toBe(0o200)
    chmodSync(source, 0o666)
    writeFileSync(source, 'model = "second"\n')

    writeRollingFileBackup(source, backup)

    expect(readFileSync(backup, 'utf-8')).toBe('model = "second"\n')
    expect(statSync(backup).mode & 0o200).toBe(0o200)
  })

  it('replaces a read-only backup an earlier version left behind', () => {
    writeFileSync(backup, 'model = "stuck"\n')
    chmodSync(backup, 0o444)
    writeFileSync(source, 'model = "current"\n')

    writeRollingFileBackup(source, backup)

    expect(readFileSync(backup, 'utf-8')).toBe('model = "current"\n')
  })

  it('replaces a read-only backup when hooks JSON is written asynchronously', async () => {
    source = join(root, 'hooks.json')
    backup = `${source}.bak`
    writeFileSync(source, '{"hooks":{}}\n')
    writeFileSync(backup, '{"stuck":true}\n')
    chmodSync(backup, 0o444)

    await writeHooksJsonAsync(source, { hooks: { Stop: [] } })

    expect(readFileSync(backup, 'utf-8')).toBe('{"hooks":{}}\n')
    expect(statSync(backup).mode & 0o200).toBe(0o200)
  })

  it('leaves a writable backup when hooks JSON itself is read-only', async () => {
    source = join(root, 'hooks.json')
    backup = `${source}.bak`
    writeFileSync(source, '{"hooks":{}}\n')
    chmodSync(source, 0o444)

    // The read-only file itself still refuses the write; its backup must not inherit that.
    await expect(writeHooksJsonAsync(source, { hooks: { Stop: [] } })).rejects.toThrow()

    expect(statSync(backup).mode & 0o200).toBe(0o200)
  })
})
