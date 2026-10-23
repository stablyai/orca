import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relocateMacAppBackups } from './macos-app-backup-relocation'

describe('relocateMacAppBackups', () => {
  let root: string
  let applicationsDir: string
  let userDataDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-app-backup-relocation-'))
    applicationsDir = join(root, 'Applications')
    userDataDir = join(root, 'Application Support', 'orca')
    await mkdir(applicationsDir, { recursive: true })
    await mkdir(join(userDataDir, 'backups'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('moves legacy application backups into a non-indexed directory', async () => {
    await mkdir(join(applicationsDir, 'Orca.app.backup-1.4.0'))
    await mkdir(join(userDataDir, 'backups', 'Orca-1.3.0.app'))

    await expect(relocateMacAppBackups({ applicationsDir, userDataDir })).resolves.toEqual({
      moved: ['backup-1.3.0', 'backup-1.4.0'],
      skipped: []
    })

    const destination = join(userDataDir, 'installer-backups.noindex')
    expect((await readdir(destination)).sort()).toEqual(['backup-1.3.0', 'backup-1.4.0'])
    expect(existsSync(join(applicationsDir, 'Orca.app.backup-1.4.0'))).toBe(false)
    expect(existsSync(join(userDataDir, 'backups', 'Orca-1.3.0.app'))).toBe(false)
  })

  it('keeps the live application and unrelated backups in place', async () => {
    await mkdir(join(applicationsDir, 'Orca.app'))
    await mkdir(join(applicationsDir, 'Another.app.backup-1.4.0'))
    await mkdir(join(userDataDir, 'backups', 'notes'))

    await expect(relocateMacAppBackups({ applicationsDir, userDataDir })).resolves.toEqual({
      moved: [],
      skipped: []
    })
    expect(existsSync(join(applicationsDir, 'Orca.app'))).toBe(true)
    expect(existsSync(join(applicationsDir, 'Another.app.backup-1.4.0'))).toBe(true)
    expect(existsSync(join(userDataDir, 'backups', 'notes'))).toBe(true)
    expect(existsSync(join(userDataDir, 'installer-backups.noindex'))).toBe(false)
  })

  it('keeps both backups when their normalized names collide', async () => {
    await mkdir(join(applicationsDir, 'Orca.app.backup-1.4.0'))
    await mkdir(join(userDataDir, 'backups', 'Orca-1.4.0.app'))

    await expect(relocateMacAppBackups({ applicationsDir, userDataDir })).resolves.toEqual({
      moved: ['backup-1.4.0', 'backup-1.4.0-2'],
      skipped: []
    })
  })

  it('moves earlier backup names already stored under user data', async () => {
    await mkdir(join(userDataDir, 'backups', 'Orca.app.backup-1.2.0'))

    await expect(relocateMacAppBackups({ applicationsDir, userDataDir })).resolves.toEqual({
      moved: ['backup-1.2.0'],
      skipped: []
    })
    expect(existsSync(join(userDataDir, 'backups', 'Orca.app.backup-1.2.0'))).toBe(false)
  })

  it('leaves a backup in place when moving it fails', async () => {
    await mkdir(join(applicationsDir, 'Orca.app.backup-1.4.0'))

    await expect(
      relocateMacAppBackups({
        applicationsDir,
        userDataDir,
        move: async () => {
          throw new Error('permission denied')
        }
      })
    ).resolves.toEqual({ moved: [], skipped: ['Orca.app.backup-1.4.0'] })
    expect(existsSync(join(applicationsDir, 'Orca.app.backup-1.4.0'))).toBe(true)
  })
})
