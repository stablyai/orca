import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

const { fsMockState } = vi.hoisted(() => ({
  fsMockState: {
    failLink: false,
    failLinkTransiently: false,
    failLinkPermission: false,
    raceTargetIntoExistence: false,
    archivePathAfterLink: null as string | null,
    failLstatPathAfterLink: null as string | null,
    failMarkerRm: false,
    failMarkerReplacement: false,
    failAuditMkdirOnce: false,
    failAuditWrites: false,
    failMkdirPath: null as string | null,
    failDirectoryPath: null as string | null,
    failLstatPath: null as string | null,
    failUnlinkPath: null as string | null
  }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      if (args[0] === fsMockState.failLstatPath) {
        return false
      }
      return actual.existsSync(...args)
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (
        fsMockState.failMarkerRm &&
        String(args[0]).includes('codex-session-backfill') &&
        String(args[0]).endsWith('backfill-complete.json')
      ) {
        const error = new Error('EACCES: marker removal failed') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.rmSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (
        fsMockState.failMarkerReplacement &&
        String(args[1]).includes('codex-session-backfill') &&
        String(args[1]).endsWith('backfill-complete.json')
      ) {
        const error = new Error('EACCES: marker replacement failed') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.renameSync(...args)
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (args[0] === fsMockState.failMkdirPath) {
        const error = new Error('EACCES: target directory inaccessible') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      if (fsMockState.failAuditMkdirOnce && String(args[0]).includes('codex-session-backfill')) {
        fsMockState.failAuditMkdirOnce = false
        const error = new Error(
          'EACCES: transient audit directory failure'
        ) as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.mkdir(...args)
    },
    appendFile: (...args: Parameters<typeof actual.appendFile>) => {
      if (fsMockState.failAuditWrites && String(args[0]).includes('codex-session-backfill')) {
        const error = new Error('ENOSPC: audit write failed') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
      return actual.appendFile(...args)
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === fsMockState.failLstatPath) {
        const error = new Error('EACCES: path inaccessible') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.lstat(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fsMockState.raceTargetIntoExistence && String(args[0]).includes('codex-runtime-home')) {
        fsMockState.raceTargetIntoExistence = false
        await actual.writeFile(args[1], 'concurrent target\n', 'utf-8')
        const error = new Error('EEXIST: concurrent target') as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      if (fsMockState.failLink && String(args[0]).includes('codex-runtime-home')) {
        const error = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      if (fsMockState.failLinkTransiently && String(args[0]).includes('codex-runtime-home')) {
        const error = new Error('EIO: transient hardlink failure') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      if (fsMockState.failLinkPermission && String(args[0]).includes('codex-runtime-home')) {
        const error = new Error('EACCES: hardlink permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      await actual.link(...args)
      if (fsMockState.failLstatPathAfterLink) {
        fsMockState.failLstatPath = fsMockState.failLstatPathAfterLink
        fsMockState.failLstatPathAfterLink = null
      }
      if (fsMockState.archivePathAfterLink) {
        const archivedPath = fsMockState.archivePathAfterLink
        fsMockState.archivePathAfterLink = null
        await actual.mkdir(dirname(archivedPath), { recursive: true })
        await actual.link(args[0], archivedPath)
      }
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (args[0] === fsMockState.failUnlinkPath) {
        const error = new Error('EACCES: active session removal denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.unlink(...args)
    },
    opendir: (...args: Parameters<typeof actual.opendir>) => {
      if (args[0] === fsMockState.failDirectoryPath) {
        const error = new Error('EACCES: directory unreadable') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.opendir(...args)
    }
  }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  backfillManagedCodexSessionsIntoSystemHome,
  resolveCodexSessionBackfillPaths
} from './codex-session-backfill'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemSessionsRoot(): string {
  return join(fakeHomeDir, '.codex', 'sessions')
}

function getSystemArchivedSessionsRoot(): string {
  return join(fakeHomeDir, '.codex', 'archived_sessions')
}

function getManagedSessionsRoot(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
}

function getAuditLogPath(): string {
  return join(userDataDir, 'codex-session-backfill', 'audit.jsonl')
}

function writeManagedSession(relativePath: string, contents: string): string {
  const filePath = join(getManagedSessionsRoot(), relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents, 'utf-8')
  return filePath
}

type BackfillAuditRecord = {
  action: string
  target?: string
  fileEventId?: string
  diagnosticEventId?: string
}

function readBackfillAuditRecords(): BackfillAuditRecord[] {
  return readFileSync(getAuditLogPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as BackfillAuditRecord]
      } catch {
        return []
      }
    })
}

function readAuditActions(): string[] {
  return readBackfillAuditRecords().map((record) => record.action)
}

beforeEach(() => {
  fsMockState.failLink = false
  fsMockState.failLinkTransiently = false
  fsMockState.failLinkPermission = false
  fsMockState.raceTargetIntoExistence = false
  fsMockState.archivePathAfterLink = null
  fsMockState.failLstatPathAfterLink = null
  fsMockState.failMarkerRm = false
  fsMockState.failMarkerReplacement = false
  fsMockState.failAuditMkdirOnce = false
  fsMockState.failAuditWrites = false
  fsMockState.failMkdirPath = null
  fsMockState.failDirectoryPath = null
  fsMockState.failLstatPath = null
  fsMockState.failUnlinkPath = null
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-backfill-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-backfill-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('backfillManagedCodexSessionsIntoSystemHome', () => {
  it('hardlinks managed rollout files into the real home preserving layout', async () => {
    const managedPath = writeManagedSession(
      join('2026', '05', '26', 'rollout-a.jsonl'),
      '{"type":"session_meta","id":"a"}\n'
    )
    writeManagedSession(join('2026', '06', '01', 'rollout-b.jsonl'), '{"id":"b"}\n')
    writeFileSync(join(getManagedSessionsRoot(), '2026', '05', '26', 'notes.txt'), 'skip me\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ scannedFiles: 2, linkedFiles: 2, failedFiles: 0 })
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(lstatSync(targetPath).ino).toBe(lstatSync(managedPath).ino)
    expect(existsSync(join(getSystemSessionsRoot(), '2026', '06', '01', 'rollout-b.jsonl'))).toBe(
      true
    )
    expect(existsSync(join(getSystemSessionsRoot(), '2026', '05', '26', 'notes.txt'))).toBe(false)
    expect(readAuditActions()).toEqual(['hardlink', 'hardlink', 'run-summary'])
  })

  it('only backfills rollout files in the exact YYYY/MM/DD layout', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-valid ü.jsonl'), 'valid\n')
    writeManagedSession(join('2026', '05', '26', 'session-index.jsonl'), 'not a rollout\n')
    writeManagedSession(join('2026', '5', '26', 'rollout-wrong-month.jsonl'), 'wrong month\n')
    writeManagedSession(join('scratch', 'rollout-too-shallow.jsonl'), 'too shallow\n')
    writeManagedSession(join('2026', '05', '26', 'nested', 'rollout-too-deep.jsonl'), 'too deep\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({
      scannedFiles: 5,
      linkedFiles: 1,
      skippedUnexpectedFiles: 4,
      failedFiles: 0
    })
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-valid ü.jsonl'))
    ).toBe(true)
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '05', '26', 'session-index.jsonl'))
    ).toBe(false)
    expect(existsSync(join(getSystemSessionsRoot(), 'scratch'))).toBe(false)
  })

  it('never overwrites an existing target file, even with different contents', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), 'managed contents\n')
    const collidingPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    mkdirSync(dirname(collidingPath), { recursive: true })
    writeFileSync(collidingPath, 'user contents\n', 'utf-8')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ scannedFiles: 1, linkedFiles: 0, skippedExistingFiles: 1 })
    expect(readFileSync(collidingPath, 'utf-8')).toBe('user contents\n')
    expect(readAuditActions()).toEqual(['existing', 'run-summary'])
  })

  it('treats an archived rollout as a durable tombstone across repeated runs', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000001.jsonl'
    )
    writeManagedSession(relativePath, 'managed contents\n')
    const archivedPath = join(getSystemArchivedSessionsRoot(), relativePath.split(/[/\\]/).at(-1)!)
    mkdirSync(dirname(archivedPath), { recursive: true })
    writeFileSync(archivedPath, 'archived contents\n', 'utf-8')
    const paths = resolveCodexSessionBackfillPaths()

    const first = await backfillManagedCodexSessionsIntoSystemHome(paths)
    const second = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(first).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1, failedFiles: 0 })
    expect(second).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1, failedFiles: 0 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(readFileSync(archivedPath, 'utf-8')).toBe('archived contents\n')
    expect(readAuditActions()).toEqual(['run-summary'])
  })

  it('fails closed when the archived rollout cannot be inspected', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000005.jsonl'
    )
    writeManagedSession(relativePath, 'managed contents\n')
    fsMockState.failLstatPath = join(
      getSystemArchivedSessionsRoot(),
      relativePath.split(/[/\\]/).at(-1)!
    )

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, failedFiles: 1 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(readAuditActions()).toEqual(['failed', 'run-summary'])
  })

  it('rolls back its new active link when an archive wins the publication race', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000003.jsonl'
    )
    writeManagedSession(relativePath, 'managed contents\n')
    const archivedPath = join(getSystemArchivedSessionsRoot(), relativePath.split(/[/\\]/).at(-1)!)
    fsMockState.archivePathAfterLink = archivedPath

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1, failedFiles: 0 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(existsSync(archivedPath)).toBe(true)
    expect(readAuditActions()).toEqual(['run-summary'])
  })

  it('rolls back its new active link when the archive race probe fails', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000006.jsonl'
    )
    writeManagedSession(relativePath, 'managed contents\n')
    fsMockState.failLstatPathAfterLink = join(
      getSystemArchivedSessionsRoot(),
      relativePath.split(/[/\\]/).at(-1)!
    )

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, failedFiles: 1 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(readAuditActions()).toEqual(['failed', 'run-summary'])
  })

  it('removes an active duplicate when the same rollout is archived', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000002.jsonl'
    )
    const managedPath = writeManagedSession(relativePath, 'managed contents\n')
    const activePath = join(getSystemSessionsRoot(), relativePath)
    const archivedPath = join(getSystemArchivedSessionsRoot(), relativePath.split(/[/\\]/).at(-1)!)
    mkdirSync(dirname(activePath), { recursive: true })
    mkdirSync(dirname(archivedPath), { recursive: true })
    linkSync(managedPath, activePath)
    linkSync(managedPath, archivedPath)

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1, failedFiles: 0 })
    expect(existsSync(activePath)).toBe(false)
    expect(lstatSync(managedPath).ino).toBe(lstatSync(archivedPath).ino)
    expect(readAuditActions()).toEqual(['run-summary'])
  })

  it('isolates an archived active-link removal failure and continues later files', async () => {
    const archivedRelativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    const managedPath = writeManagedSession(archivedRelativePath, 'archived contents\n')
    const activePath = join(getSystemSessionsRoot(), archivedRelativePath)
    const archivedPath = join(getSystemArchivedSessionsRoot(), 'rollout-a.jsonl')
    mkdirSync(dirname(activePath), { recursive: true })
    mkdirSync(dirname(archivedPath), { recursive: true })
    linkSync(managedPath, activePath)
    linkSync(managedPath, archivedPath)
    fsMockState.failUnlinkPath = activePath

    const laterRelativePath = join('2026', '05', '26', 'rollout-b.jsonl')
    writeManagedSession(laterRelativePath, 'later contents\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({
      scannedFiles: 2,
      linkedFiles: 1,
      skippedExistingFiles: 0,
      failedFiles: 1
    })
    expect(existsSync(activePath)).toBe(true)
    expect(existsSync(join(getSystemSessionsRoot(), laterRelativePath))).toBe(true)
    expect(readAuditActions().toSorted()).toEqual(['failed', 'hardlink', 'run-summary'].toSorted())
  })

  it('preserves an ambiguous active file when it differs from the archived rollout', async () => {
    const relativePath = join(
      '2026',
      '05',
      '26',
      'rollout-2026-05-26T10-00-00-019f0000-1111-7222-8333-000000000004.jsonl'
    )
    writeManagedSession(relativePath, 'managed contents\n')
    const activePath = join(getSystemSessionsRoot(), relativePath)
    const archivedPath = join(getSystemArchivedSessionsRoot(), relativePath.split(/[/\\]/).at(-1)!)
    mkdirSync(dirname(activePath), { recursive: true })
    mkdirSync(dirname(archivedPath), { recursive: true })
    writeFileSync(activePath, 'different active contents\n', 'utf-8')
    writeFileSync(archivedPath, 'archived contents\n', 'utf-8')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1, failedFiles: 0 })
    expect(readFileSync(activePath, 'utf-8')).toBe('different active contents\n')
    expect(readFileSync(archivedPath, 'utf-8')).toBe('archived contents\n')
    expect(readAuditActions()).toEqual(['run-summary'])
  })
})
