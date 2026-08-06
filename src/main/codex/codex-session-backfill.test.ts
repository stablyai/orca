import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
    failInstallLink: false,
    failInstallLinkTransiently: false,
    raceTargetIntoExistence: false,
    failCopy: false,
    failAuditMkdirOnce: false,
    failAuditWrites: false,
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
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
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
      // Simulate a target filesystem with no hardlink support: even the
      // same-volume staged-copy install link (.orca-backfill-*.tmp) fails.
      if (fsMockState.failInstallLink && String(args[0]).includes('.orca-backfill-')) {
        const error = new Error('EPERM: hardlinks unsupported') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      if (fsMockState.failInstallLinkTransiently && String(args[0]).includes('.orca-backfill-')) {
        const error = new Error('EIO: transient install failure') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return actual.link(...args)
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      if (fsMockState.failCopy) {
        // Simulate a copy that fails after opening its destination, which is
        // the dangerous case for resumability rather than a preflight error.
        await actual.writeFile(args[1], 'partial copy\n', 'utf-8')
        const error = new Error('EACCES: copy disabled for test') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.copyFile(...args)
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

function readAuditActions(): string[] {
  return readFileSync(getAuditLogPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [(JSON.parse(line) as { action: string }).action]
      } catch {
        return []
      }
    })
}

beforeEach(() => {
  fsMockState.failLink = false
  fsMockState.failInstallLink = false
  fsMockState.failInstallLinkTransiently = false
  fsMockState.raceTargetIntoExistence = false
  fsMockState.failCopy = false
  fsMockState.failAuditMkdirOnce = false
  fsMockState.failAuditWrites = false
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

  it('falls back to copy when hardlinking fails across volumes', async () => {
    fsMockState.failLink = true
    const managedPath = writeManagedSession(
      join('2026', '05', '26', 'rollout-a ü.jsonl'),
      '{"id":"a"}\n'
    )

    const summary = await backfillManagedCodexSessionsIntoSystemHome(
      resolveCodexSessionBackfillPaths()
    )

    expect(summary).toMatchObject({ linkedFiles: 0, copiedFiles: 1, failedFiles: 0 })
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a ü.jsonl')
    expect(readFileSync(targetPath, 'utf-8')).toBe(readFileSync(managedPath, 'utf-8'))
    expect(lstatSync(targetPath).ino).not.toBe(lstatSync(managedPath).ino)
    expect(readAuditActions()).toEqual(['copy', 'run-summary'])
  })

  it('fails closed when the target filesystem cannot install without overwrite', async () => {
    fsMockState.failLink = true
    fsMockState.failInstallLink = true
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

  it('keeps transient install failures retryable', async () => {
    fsMockState.failLink = true
    fsMockState.failInstallLinkTransiently = true
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

  it('records per-file failures without aborting the run', async () => {
    fsMockState.failLink = true
    fsMockState.failCopy = true
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

  it('writes a completion marker and skips the walk on later runs', async () => {
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ linkedFiles: 1, failedFiles: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ version: 3 })

    // A file appearing after the marker must not be backfilled again.
    writeManagedSession(join('2026', '07', '01', 'rollout-later.jsonl'), '{"id":"later"}\n')
    const second = await startCodexSessionBackfillInBackground()
    expect(second).toBeNull()
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '07', '01', 'rollout-later.jsonl'))
    ).toBe(false)
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
    fsMockState.failInstallLink = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ skippedUnsupportedFilesystemFiles: 1, failedFiles: 0 })
    expect(existsSync(getMarkerPath())).toBe(true)

    expect(await startCodexSessionBackfillInBackground()).toBeNull()
  })

  it('leaves the marker unset when any file fails so the next startup retries', async () => {
    fsMockState.failLink = true
    fsMockState.failCopy = true
    writeManagedSession(join('2026', '05', '26', 'rollout-a.jsonl'), '{"id":"a"}\n')

    const first = await startCodexSessionBackfillInBackground()
    expect(first).toMatchObject({ failedFiles: 1 })
    expect(existsSync(getMarkerPath())).toBe(false)
    const targetPath = join(getSystemSessionsRoot(), '2026', '05', '26', 'rollout-a.jsonl')
    expect(existsSync(targetPath)).toBe(false)

    fsMockState.failLink = false
    fsMockState.failCopy = false
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
