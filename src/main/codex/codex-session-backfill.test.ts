import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    failMarkerRm: false,
    failMarkerReplacement: false,
    failAuditMkdirOnce: false,
    failAuditWrites: false,
    failMkdirPath: null as string | null,
    failDirectoryPath: null as string | null,
    failLstatPath: null as string | null
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
      return actual.link(...args)
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
  resolveCodexSessionBackfillPaths,
  startCodexSessionBackfillInBackground
} from './codex-session-backfill'
import { invalidateCodexSessionBackfillMarker } from './codex-session-backfill-marker'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemSessionsRoot(): string {
  return join(fakeHomeDir, '.codex', 'sessions')
}

function getManagedSessionsRoot(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
}

function getMarkerPath(): string {
  return join(userDataDir, 'codex-session-backfill', 'backfill-complete.json')
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
  fsMockState.failMarkerRm = false
  fsMockState.failMarkerReplacement = false
  fsMockState.failAuditMkdirOnce = false
  fsMockState.failAuditWrites = false
  fsMockState.failMkdirPath = null
  fsMockState.failDirectoryPath = null
  fsMockState.failLstatPath = null
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

  it('enqueues a target that appears after the existence probe', async () => {
    fsMockState.raceTargetIntoExistence = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), 'managed contents\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(summary).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1 })
    expect(readFileSync(targetPath, 'utf-8')).toBe('concurrent target\n')
    expect(readAuditActions()).toEqual(['existing', 'run-summary'])
  })

  it('keeps recovery records parseable after a torn audit tail', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), 'managed contents\n')
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, 'existing target\n', 'utf-8')
    mkdirSync(dirname(getAuditLogPath()), { recursive: true })
    writeFileSync(getAuditLogPath(), '{"torn":', 'utf-8')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ skippedExistingFiles: 1, failedHealAuditRecords: 0 })
    expect(readAuditActions()).toEqual(['existing', 'run-summary'])
  })

  it('treats a broken symlink at the target as taken', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), 'managed contents\n')
    const collidingPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    mkdirSync(dirname(collidingPath), { recursive: true })
    try {
      symlinkSync(join(fakeHomeDir, 'missing-target.jsonl'), collidingPath)
    } catch {
      // Windows without symlink privilege cannot set up this fixture.
      return
    }

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, copiedFiles: 0, skippedExistingFiles: 1 })
    expect(lstatSync(collidingPath).isSymbolicLink()).toBe(true)
  })

  it('does not backfill symlinked managed session files', async () => {
    const realSource = join(fakeHomeDir, 'outside.jsonl')
    writeFileSync(realSource, 'outside contents\n', 'utf-8')
    const managedLinkPath = join(getManagedSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    mkdirSync(dirname(managedLinkPath), { recursive: true })
    try {
      symlinkSync(realSource, managedLinkPath)
    } catch {
      return
    }

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    // Why: the session walker skips symlink dirents, so bridge-created links
    // (which point back into the user's own home) never reach the copier.
    expect(summary).toMatchObject({ linkedFiles: 0, copiedFiles: 0, failedFiles: 0 })
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(existsSync(targetPath)).toBe(false)
  })

  it('is idempotent: a second run links nothing new and changes nothing', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    const paths = resolveCodexSessionBackfillPaths()

    const first = await backfillManagedCodexSessionsIntoSystemHome(paths)
    const second = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(first).toMatchObject({ linkedFiles: 1 })
    expect(second).toMatchObject({ linkedFiles: 0, copiedFiles: 0, skippedExistingFiles: 1 })
  })

  it('retries the same audit record after a transient directory failure', async () => {
    fsMockState.failAuditMkdirOnce = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 1, failedFiles: 0 })
    expect(readAuditActions()).toEqual(['hardlink', 'run-summary'])
  })

  it('skips cross-volume rollouts instead of freezing a mutable snapshot', async () => {
    fsMockState.failLink = true
    const relativePath = join('2026', '05', '26', 'rollout-a ü.jsonl')
    writeManagedSession(relativePath, '{"id":"a"}\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ copiedFiles: 0, skippedUnsupportedFilesystemFiles: 1 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(readAuditActions()).toEqual(['copy-unsupported', 'run-summary'])
  })

  it('fails closed when the target filesystem cannot install without overwrite', async () => {
    fsMockState.failLink = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({
      linkedFiles: 0,
      copiedFiles: 0,
      skippedUnsupportedFilesystemFiles: 1,
      failedFiles: 0
    })
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(existsSync(targetPath)).toBe(false)
    expect(readdirSync(dirname(targetPath))).toEqual([])
    expect(readAuditActions()).toEqual(['copy-unsupported', 'run-summary'])
  })

  it('keeps transient hardlink failures retryable', async () => {
    fsMockState.failLinkTransiently = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({
      skippedUnsupportedFilesystemFiles: 0,
      failedFiles: 1
    })
    expect(readAuditActions()).toEqual(['failed', 'run-summary'])
  })

  it('keeps target directory permission failures retryable', async () => {
    const relativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    writeManagedSession(relativePath, '{"id":"a"}\n')
    fsMockState.failMkdirPath = dirname(join(getSystemSessionsRoot(), relativePath))

    const summary = await startCodexSessionBackfillInBackground()

    expect(summary).toMatchObject({ failedFiles: 1, skippedUnsupportedFilesystemFiles: 0 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(existsSync(getMarkerPath())).toBe(false)
    expect(readAuditActions()).toEqual(['failed', 'run-summary'])
  })

  it('keeps hardlink permission failures retryable', async () => {
    fsMockState.failLinkPermission = true
    const relativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    writeManagedSession(relativePath, '{"id":"a"}\n')

    const summary = await startCodexSessionBackfillInBackground()

    expect(summary).toMatchObject({ failedFiles: 1, skippedUnsupportedFilesystemFiles: 0 })
    expect(existsSync(join(getSystemSessionsRoot(), relativePath))).toBe(false)
    expect(existsSync(getMarkerPath())).toBe(false)
  })

  it('records per-file failures without aborting the run', async () => {
    fsMockState.failLinkTransiently = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ failedFiles: 1, linkedFiles: 0, copiedFiles: 0 })
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(existsSync(targetPath)).toBe(false)
    expect(readdirSync(dirname(targetPath))).toEqual([])
    expect(readAuditActions()).toEqual(['failed', 'run-summary'])
  })

  it('does not create the real sessions tree when there is nothing to backfill', async () => {
    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ scannedFiles: 0 })
    expect(existsSync(getSystemSessionsRoot())).toBe(false)
  })

  it('bounds a launch pass to its rollout date directories', async () => {
    const oldRelativePath = join('2025', '12', '31', 'rollout-old.jsonl')
    const launchRelativePath = join('2026', '08', '05', 'rollout-launch.jsonl')
    writeManagedSession(oldRelativePath, 'old\n')
    writeManagedSession(launchRelativePath, 'launch\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths(),
      { scanDates: [['2026', '08', '05']] }
    )

    expect(summary).toMatchObject({ scannedFiles: 1, linkedFiles: 1, failedDirectories: 0 })
    expect(existsSync(join(getSystemSessionsRoot(), launchRelativePath))).toBe(true)
    expect(existsSync(join(getSystemSessionsRoot(), oldRelativePath))).toBe(false)
  })

  it('treats a not-yet-created launch date as an empty bounded pass', async () => {
    writeManagedSession(join('2025', '12', '31', 'rollout-old.jsonl'), 'old\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths(),
      { scanDates: [['2026', '08', '05']] }
    )

    expect(summary).toMatchObject({ scannedFiles: 0, linkedFiles: 0, failedDirectories: 0 })
  })
})

describe('startCodexSessionBackfillInBackground', () => {
  it('stops target mutations after real-home opt-out and leaves the run retryable', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    writeManagedSession(join('2026', '05', '26', 'rollout-b.jsonl'), '{"id":"b"}\n')
    let stopChecks = 0

    const stopped = await startCodexSessionBackfillInBackground({
      yieldMs: 0,
      shouldStop: () => stopChecks++ >= 1
    })

    expect(stopped).toMatchObject({ stopped: true, linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)

    const resumed = await startCodexSessionBackfillInBackground({ yieldMs: 0 })
    expect(resumed).toMatchObject({ stopped: false, linkedFiles: 1, skippedExistingFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('does not publish completion when opt-out lands during final audit', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    let stopChecks = 0

    const stopped = await startCodexSessionBackfillInBackground({
      shouldStop: () => stopChecks++ >= 2
    })

    expect(stopped).toMatchObject({ stopped: true, linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
  })

  it('defers completion while a launch lease is active', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const active = await startCodexSessionBackfillInBackground({
      writeCompletionMarker: false
    })
    expect(active).toMatchObject({ linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)

    const completed = await startCodexSessionBackfillInBackground()
    expect(completed).toMatchObject({ skippedExistingFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('rechecks launch state before publishing completion', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await startCodexSessionBackfillInBackground({
      canWriteCompletionMarker: () => false
    })

    expect(summary).toMatchObject({ linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
  })

  it('keeps an invalidated active pass from recreating the completion marker', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    let invalidated = false

    const raced = await startCodexSessionBackfillInBackground({
      shouldStop: () => {
        if (!invalidated) {
          invalidated = true
          invalidateCodexSessionBackfillMarker(getMarkerPath())
        }
        return false
      }
    })

    expect(raced).toMatchObject({ linkedFiles: 1, stopped: false })
    expect(existsSync(getMarkerPath())).toBe(false)
    const racedAudit = readFileSync(getAuditLogPath(), 'utf-8')

    const recovered = await startCodexSessionBackfillInBackground()

    expect(recovered).toMatchObject({ skippedExistingFiles: 1, failedHealAuditRecords: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)
    expect(readFileSync(getAuditLogPath(), 'utf-8')).toBe(racedAudit)
  })

  it('replaces a stale marker when direct removal fails', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()
    fsMockState.failMarkerRm = true

    invalidateCodexSessionBackfillMarker(getMarkerPath())

    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 0 })
    const recovered = await startCodexSessionBackfillInBackground()
    expect(recovered).toMatchObject({ skippedExistingFiles: 1 })
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 3 })
  })

  it('fails launch preparation when a stale marker cannot be invalidated', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()
    fsMockState.failMarkerRm = true
    fsMockState.failMarkerReplacement = true

    expect(() => invalidateCodexSessionBackfillMarker(getMarkerPath())).toThrow(
      'Failed to invalidate Codex session backfill marker'
    )
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 3 })
  })

  it('writes a completion marker and skips the walk on later runs', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ linkedFiles: 1, failedFiles: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 3 })

    // An ordinary call remains a no-op; only a launch-scheduled pass bypasses the marker.
    writeManagedSession(join('2026', '07', '01', 'rollout-later.jsonl'), '{"id":"later"}\n')
    const second = await startCodexSessionBackfillInBackground()
    expect(second).toBeNull()
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '07', '01', 'rollout-later.jsonl'))
    ).toBe(false)

    const scheduled = await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      scanDates: [['2026', '07', '01']]
    })
    expect(scheduled).toMatchObject({ scannedFiles: 1, linkedFiles: 1 })
  })

  it('does not let a bounded pass certify older unscanned history', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()

    invalidateCodexSessionBackfillMarker(getMarkerPath())
    const missedRelativePath = join('2026', '06', '01', 'rollout-missed.jsonl')
    writeManagedSession(missedRelativePath, 'missed\n')
    writeManagedSession(join('2026', '08', '05', 'rollout-launch.jsonl'), 'launch\n')

    const bounded = await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      scanDates: [['2026', '08', '05']]
    })
    expect(bounded).toMatchObject({ scannedFiles: 1, linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)

    const recovered = await startCodexSessionBackfillInBackground()
    expect(recovered).toMatchObject({ scannedFiles: 3, linkedFiles: 1 })
    expect(existsSync(join(getSystemSessionsRoot(), missedRelativePath))).toBe(true)
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('lets an explicit bounded final pass restore a certified baseline', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()

    invalidateCodexSessionBackfillMarker(getMarkerPath())
    writeManagedSession(join('2026', '08', '05', 'rollout-launch.jsonl'), 'launch\n')

    const bounded = await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      scanDates: [['2026', '08', '05']],
      writeBoundedCompletionMarker: true
    })

    expect(bounded).toMatchObject({ scannedFiles: 1, linkedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('records a new heal event when a linked rollout grows in place', async () => {
    const relativePath = join('2026', '05', '26', 'rollout-growing.jsonl')
    const managedPath = writeManagedSession(relativePath, '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()

    const firstRecord = readBackfillAuditRecords().find((record) => record.action === 'hardlink')
    invalidateCodexSessionBackfillMarker(getMarkerPath())
    appendFileSync(managedPath, '{"event":"later"}\n', 'utf-8')
    await startCodexSessionBackfillInBackground()

    const fileRecords = readBackfillAuditRecords().filter((record) =>
      ['hardlink', 'existing'].includes(record.action)
    )
    expect(fileRecords).toHaveLength(2)
    expect(fileRecords[1]).toMatchObject({ action: 'existing' })
    expect(fileRecords[1]?.fileEventId).not.toBe(firstRecord?.fileEventId)
  })

  it('keeps repeated launch invalidations audit-stable', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ linkedFiles: 1, failedHealAuditRecords: 0 })
    const firstAudit = readFileSync(getAuditLogPath(), 'utf-8')

    for (let pass = 0; pass < 2; pass += 1) {
      invalidateCodexSessionBackfillMarker(getMarkerPath())
      const repeated = await startCodexSessionBackfillInBackground()
      expect(repeated).toMatchObject({
        linkedFiles: 0,
        copiedFiles: 0,
        skippedExistingFiles: 1,
        failedHealAuditRecords: 0
      })
      expect(readFileSync(getAuditLogPath(), 'utf-8')).toBe(firstAudit)
    }

    const fileRecords = readBackfillAuditRecords().filter((record) =>
      ['hardlink', 'copy', 'existing'].includes(record.action)
    )
    expect(fileRecords).toEqual([
      expect.objectContaining({ action: 'hardlink', fileEventId: expect.any(String) })
    ])
  })

  it('recovers a post-install audit interruption without duplicating prior events', async () => {
    const firstRelativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    const secondRelativePath = join('2026', '05', '26', 'rollout-b.jsonl')
    writeManagedSession(firstRelativePath, '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()

    invalidateCodexSessionBackfillMarker(getMarkerPath())
    writeManagedSession(secondRelativePath, '{"id":"b"}\n')
    fsMockState.failAuditWrites = true

    const interrupted = await startCodexSessionBackfillInBackground()

    expect(interrupted).toMatchObject({ linkedFiles: 1, failedHealAuditRecords: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
    expect(
      readBackfillAuditRecords().filter((record) =>
        ['hardlink', 'copy', 'existing'].includes(record.action)
      )
    ).toHaveLength(1)

    fsMockState.failAuditWrites = false
    const recovered = await startCodexSessionBackfillInBackground()

    expect(recovered).toMatchObject({
      linkedFiles: 0,
      skippedExistingFiles: 2,
      failedHealAuditRecords: 0
    })
    expect(existsSync(getMarkerPath())).toBe(true)
    const recoveredFileRecords = readBackfillAuditRecords().filter((record) =>
      ['hardlink', 'copy', 'existing'].includes(record.action)
    )
    expect(recoveredFileRecords).toHaveLength(2)
    expect(new Set(recoveredFileRecords.map((record) => record.target))).toEqual(
      new Set([
        join(getSystemSessionsRoot(), firstRelativePath),
        join(getSystemSessionsRoot(), secondRelativePath)
      ])
    )
  })

  it('self-heals a zero-file marker when managed rollouts appear later', async () => {
    const empty = await startCodexSessionBackfillInBackground()
    expect(empty).toMatchObject({ scannedFiles: 0, linkedFiles: 0 })
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({
      summary: { scannedFiles: 0 }
    })

    writeManagedSession(join('2026', '07', '28', 'rollout-later.jsonl'), '{"id":"later"}\n')
    const healed = await startCodexSessionBackfillInBackground()

    expect(healed).toMatchObject({ scannedFiles: 1, linkedFiles: 1 })
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '07', '28', 'rollout-later.jsonl'))
    ).toBe(true)
  })

  it('recovers an installed rollout after the completion marker write fails', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    mkdirSync(getMarkerPath(), { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toBeNull()
    expect(existsSync(join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl'))).toBe(
      true
    )

    rmSync(getMarkerPath(), { recursive: true })
    const resumed = await startCodexSessionBackfillInBackground()
    expect(resumed).toMatchObject({ skippedExistingFiles: 1, failedHealAuditRecords: 0 })
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 3 })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('re-enqueues an installed rollout after its audit write fails', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    fsMockState.failAuditWrites = true

    const first = await startCodexSessionBackfillInBackground()

    expect(first).toMatchObject({ linkedFiles: 1, failedHealAuditRecords: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)

    fsMockState.failAuditWrites = false
    const second = await startCodexSessionBackfillInBackground()

    expect(second).toMatchObject({ skippedExistingFiles: 1, failedHealAuditRecords: 0 })
    expect(readAuditActions()).toEqual(['existing', 'run-summary'])
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('does not retry a stable hardlink-less filesystem limitation', async () => {
    fsMockState.failLink = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ skippedUnsupportedFilesystemFiles: 1, failedFiles: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)

    const firstAudit = readFileSync(getAuditLogPath(), 'utf-8')
    invalidateCodexSessionBackfillMarker(getMarkerPath())
    const repeated = await startCodexSessionBackfillInBackground()

    expect(repeated).toMatchObject({ skippedUnsupportedFilesystemFiles: 1, failedFiles: 0 })
    expect(readFileSync(getAuditLogPath(), 'utf-8')).toBe(firstAudit)

    expect(await startCodexSessionBackfillInBackground()).toBeNull()
  })

  it('keeps repeated unchanged per-file failures audit-stable', async () => {
    fsMockState.failLinkTransiently = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ failedFiles: 1 })
    const firstAudit = readFileSync(getAuditLogPath(), 'utf-8')

    const repeated = await startCodexSessionBackfillInBackground()

    expect(repeated).toMatchObject({ failedFiles: 1 })
    expect(readFileSync(getAuditLogPath(), 'utf-8')).toBe(firstAudit)
  })

  it('records a new failure event when the source file changes', async () => {
    fsMockState.failLinkTransiently = true
    const relativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    writeManagedSession(relativePath, '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()

    writeManagedSession(relativePath, '{"id":"a","changed":true}\n')
    await startCodexSessionBackfillInBackground()

    const failedRecords = readBackfillAuditRecords().filter((record) => record.action === 'failed')
    expect(failedRecords).toHaveLength(2)
    expect(new Set(failedRecords.map((record) => record.diagnosticEventId)).size).toBe(2)
  })

  it('leaves the marker unset when any file fails so the next startup retries', async () => {
    fsMockState.failLinkTransiently = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ failedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(existsSync(targetPath)).toBe(false)

    fsMockState.failLinkTransiently = false
    const second = await startCodexSessionBackfillInBackground()
    expect(second).toMatchObject({ linkedFiles: 1, failedFiles: 0 })
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"id":"a"}\n')
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('leaves the marker unset when a directory cannot be scanned', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-readable.jsonl'), 'readable\n')
    const unreadableDirectory = dirname(
      writeManagedSession(join('2026', '06', '01', 'rollout-unreadable.jsonl'), 'unreadable\n')
    )
    fsMockState.failDirectoryPath = unreadableDirectory

    const first = await startCodexSessionBackfillInBackground({ yieldMs: 0 })

    expect(first).toMatchObject({ failedDirectories: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
    expect(readAuditActions()).toContain('scan-failed')

    fsMockState.failDirectoryPath = null
    const second = await startCodexSessionBackfillInBackground({ yieldMs: 0 })
    expect(second).toMatchObject({ failedDirectories: 0, failedFiles: 0 })
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '06', '01', 'rollout-unreadable.jsonl'))
    ).toBe(true)
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('leaves the marker unset when the managed sessions root is inaccessible', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    fsMockState.failLstatPath = getManagedSessionsRoot()

    const first = await startCodexSessionBackfillInBackground()

    expect(first).toMatchObject({ scannedFiles: 0, failedDirectories: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
    expect(readAuditActions()).toContain('scan-failed')

    fsMockState.failLstatPath = null
    const second = await startCodexSessionBackfillInBackground()
    expect(second).toMatchObject({ linkedFiles: 1, failedDirectories: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('honors a custom system Codex home override', async () => {
    const customHome = join(fakeHomeDir, 'custom-codex-home')
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const summary = await startCodexSessionBackfillInBackground({}, customHome)

    expect(summary).toMatchObject({ linkedFiles: 1 })
    expect(existsSync(join(customHome, 'sessions', '2026', '05', '26', 'rollout-a.jsonl'))).toBe(
      true
    )
    expect(existsSync(getSystemSessionsRoot())).toBe(false)
  })

  it('re-runs when the configured real Codex home changes', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()
    const customHome = join(fakeHomeDir, 'custom Codex ü')

    const moved = await startCodexSessionBackfillInBackground({}, customHome)

    expect(moved).toMatchObject({ linkedFiles: 1, failedFiles: 0 })
    expect(existsSync(join(customHome, 'sessions', '2026', '05', '26', 'rollout-a.jsonl'))).toBe(
      true
    )
    expect(await startCodexSessionBackfillInBackground({}, customHome)).toBeNull()
  })
})
