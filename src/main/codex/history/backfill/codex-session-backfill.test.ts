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

vi.mock('node:fs', async () => {
  const mocks = await import('./codex-session-backfill-fs-mocks')
  return mocks.createNodeFsMock(await vi.importActual<typeof NodeFs>('node:fs'))
})

vi.mock('node:fs/promises', async () => {
  const mocks = await import('./codex-session-backfill-fs-mocks')
  return mocks.createNodeFsPromisesMock(
    await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  )
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
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'
import {
  markCodexSessionBackfillMarkerNeedsFullScan,
  markCodexSessionBackfillMarkerPending
} from './codex-session-backfill-marker'
import { fsMockState, resetCodexSessionBackfillFsMocks } from './codex-session-backfill-fs-mocks'
import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

const FIXTURE_LAUNCH_DATE: CodexSessionBackfillDate = ['2026', '05', '26']

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

function markLaunchPending(...scanDates: CodexSessionBackfillDate[]): void {
  markCodexSessionBackfillMarkerPending(
    getMarkerPath(),
    getSystemSessionsRoot(),
    scanDates.length > 0 ? scanDates : [FIXTURE_LAUNCH_DATE]
  )
}

function readMarker(): Record<string, unknown> {
  return JSON.parse(readFileSync(getMarkerPath(), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  resetCodexSessionBackfillFsMocks()
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
  vi.useRealTimers()
  vi.unstubAllEnvs()
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
})

describe('startCodexSessionBackfillInBackground', () => {
  describe.each([
    ['Asia/Seoul', '2026-10-26T15:53:24Z'],
    ['America/Los_Angeles', '2026-10-27T05:00:00Z']
  ])('local and shell-TZ rollouts in %s', (timeZone, instant) => {
    it.each(['launch', 'exit', 'recovery'])(
      'publishes both date shards after %s',
      async (trigger) => {
        vi.stubEnv('TZ', timeZone)
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(instant))
        writeManagedSession(join('2026', '05', '26', 'rollout-baseline.jsonl'), 'baseline\n')
        await startCodexSessionBackfillInBackground()
        if (trigger === 'recovery') {
          markLaunchPending(['2026', '10', timeZone === 'Asia/Seoul' ? '25' : '28'])
          await startCodexSessionBackfillInBackground({ retainPendingScanDates: true })
        }
        writeManagedSession(join('2026', '10', '26', 'rollout-26.jsonl'), 'day 26\n')
        writeManagedSession(join('2026', '10', '27', 'rollout-27.jsonl'), 'day 27\n')
        writeManagedSession(join('2026', '01', '01', 'rollout-unrelated.jsonl'), 'unrelated\n')
        await (trigger === 'exit'
          ? new Promise<void>((resolve, reject) => {
              const scheduler = createCodexSessionMigrationScheduler({
                isEligible: () => true,
                isQuitting: () => false,
                resolveSystemCodexHomePathOverride: () => undefined,
                startBackfill: (options) =>
                  startCodexSessionBackfillInBackground(options).catch(reject),
                startIndexHeal: async () => {},
                finishScheduledRun: resolve,
                initialDelayMs: 0
              })
              scheduler.beginLaunch('launch', false, new Date(instant))
              scheduler.finishLaunch('launch')
            })
          : startCodexSessionBackfillInBackground({ ignoreCompletionMarker: trigger === 'launch' }))
        expect(
          readFileSync(
            join(getSystemSessionsRoot(), '2026', '10', '26', 'rollout-26.jsonl'),
            'utf-8'
          )
        ).toBe('day 26\n')
        expect(
          readFileSync(
            join(getSystemSessionsRoot(), '2026', '10', '27', 'rollout-27.jsonl'),
            'utf-8'
          )
        ).toBe('day 27\n')
        expect(
          existsSync(join(getSystemSessionsRoot(), '2026', '01', '01', 'rollout-unrelated.jsonl'))
        ).toBe(false)
      }
    )
  })

  it.each([true, false])(
    'recovers historical sessions omitted by a date-filtered pass with boundedScan=%s',
    async (boundedScan) => {
      const missedRelativePath = join('2026', '06', '01', 'rollout-missed.jsonl')
      writeManagedSession(missedRelativePath, 'missed\n')
      writeManagedSession(join('2026', '08', '05', 'rollout-launch.jsonl'), 'launch\n')
      await startCodexSessionBackfillInBackground({
        boundedScan,
        scanFrom: ['2026', '08', '05']
      })
      expect(existsSync(join(getSystemSessionsRoot(), missedRelativePath))).toBe(false)
      await startCodexSessionBackfillInBackground()
      expect(readFileSync(join(getSystemSessionsRoot(), missedRelativePath), 'utf-8')).toBe(
        'missed\n'
      )
    }
  )

  it('resumes older publication after a capped launch while still publishing fresh rollouts', async () => {
    writeManagedSession(join('2025', '01', '01', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()
    for (const month of ['01', '02']) {
      for (let day = 1; day <= 28; day += 1) {
        writeManagedSession(
          join('2026', month, String(day).padStart(2, '0'), 'rollout-a.jsonl'),
          'history\n'
        )
      }
    }
    await startCodexSessionBackfillInBackground({ ignoreCompletionMarker: true })
    expect(existsSync(join(getSystemSessionsRoot(), '2026', '01', '25', 'rollout-a.jsonl'))).toBe(
      false
    )
    for (const day of ['01', '02', '03']) {
      writeManagedSession(join('2026', '03', day, 'rollout-new.jsonl'), 'new\n')
    }
    await startCodexSessionBackfillInBackground()
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(join(getSystemSessionsRoot(), '2026', '03', '01', 'rollout-new.jsonl'), 'utf-8')
    ).toBe('new\n')
    expect(
      readFileSync(join(getSystemSessionsRoot(), '2026', '01', '01', 'rollout-a.jsonl'), 'utf-8')
    ).toBe('history\n')
  })

  it('resumes a capped full-history request below the previous scan floor', async () => {
    writeManagedSession(join('2026', '10', '01', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()
    for (const month of ['01', '02']) {
      for (let day = 1; day <= 28; day += 1) {
        writeManagedSession(
          join('2026', month, String(day).padStart(2, '0'), 'rollout-older.jsonl'),
          'older\n'
        )
      }
    }
    await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      fullScanRequired: true
    })
    expect(
      existsSync(join(getSystemSessionsRoot(), '2026', '01', '01', 'rollout-older.jsonl'))
    ).toBe(false)
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(
        join(getSystemSessionsRoot(), '2026', '01', '01', 'rollout-older.jsonl'),
        'utf-8'
      )
    ).toBe('older\n')
  })

  it('revisits a scanned prefix when a bounded continuation receives a full-history request', async () => {
    writeManagedSession(join('2025', '01', '01', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()
    for (const month of ['01', '02']) {
      for (let day = 1; day <= 28; day += 1) {
        writeManagedSession(
          join('2026', month, String(day).padStart(2, '0'), 'rollout-older.jsonl'),
          'older\n'
        )
      }
    }
    await startCodexSessionBackfillInBackground({ ignoreCompletionMarker: true })
    writeManagedSession(join('2026', '02', '01', 'rollout-late.jsonl'), 'late\n')
    await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      fullScanRequired: true
    })
    expect(
      readFileSync(join(getSystemSessionsRoot(), '2026', '02', '01', 'rollout-late.jsonl'), 'utf-8')
    ).toBe('late\n')
  })

  it('replays the visited prefix after a new full request without dropping the owed tail', async () => {
    writeManagedSession(join('2026', '10', '01', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()
    for (const month of ['01', '02']) {
      for (let day = 1; day <= 28; day += 1) {
        writeManagedSession(
          join('2026', month, String(day).padStart(2, '0'), 'rollout-older.jsonl'),
          'older\n'
        )
      }
    }
    await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      fullScanRequired: true
    })
    writeManagedSession(join('2026', '02', '01', 'rollout-late.jsonl'), 'late\n')
    markCodexSessionBackfillMarkerNeedsFullScan(getMarkerPath(), true)
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(
        join(getSystemSessionsRoot(), '2026', '01', '01', 'rollout-older.jsonl'),
        'utf-8'
      )
    ).toBe('older\n')
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(join(getSystemSessionsRoot(), '2026', '02', '01', 'rollout-late.jsonl'), 'utf-8')
    ).toBe('late\n')
    await startCodexSessionBackfillInBackground()
  })

  it.each([
    ['month', ['2017', '03']],
    ['year', ['2017']]
  ])('resumes a %s subtree cursor through its day folders', async (_kind, cursor) => {
    writeManagedSession(join('2000', '01', '01', 'rollout-baseline.jsonl'), 'baseline\n')
    await startCodexSessionBackfillInBackground()
    writeFileSync(
      getMarkerPath(),
      JSON.stringify({
        ...readMarker(),
        scanCursor: cursor,
        scanCheckpoint: ['2026', '02', '28'],
        launchActive: true
      })
    )
    for (const day of ['01', '02', '03']) {
      writeManagedSession(join('2026', '03', day, 'rollout-new.jsonl'), 'fresh\n')
    }
    writeManagedSession(join('2017', '03', '01', 'rollout-older.jsonl'), 'older\n')
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(
        join(getSystemSessionsRoot(), '2017', '03', '01', 'rollout-older.jsonl'),
        'utf-8'
      )
    ).toBe('older\n')
  })

  it('recovers a local rollout below an old UTC-only pending marker', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T05:00:00Z'))
    mkdirSync(dirname(getMarkerPath()), { recursive: true })
    writeFileSync(
      getMarkerPath(),
      JSON.stringify({
        version: 4,
        coverage: 'full',
        systemSessionsRoot: getSystemSessionsRoot(),
        baselineScannedFiles: 1,
        pendingScanDates: [['2026', '10', '27']],
        launchActive: true
      })
    )
    writeManagedSession(join('2026', '10', '26', 'rollout-la.jsonl'), 'local\n')
    await startCodexSessionBackfillInBackground()
    expect(
      readFileSync(join(getSystemSessionsRoot(), '2026', '10', '26', 'rollout-la.jsonl'), 'utf-8')
    ).toBe('local\n')
  })

  it('recovers a post-install audit interruption without duplicating prior events', async () => {
    const firstRelativePath = join('2026', '05', '26', 'rollout-a.jsonl')
    const secondRelativePath = join('2026', '05', '26', 'rollout-b.jsonl')
    writeManagedSession(firstRelativePath, '{"id":"a"}\n')
    await startCodexSessionBackfillInBackground()

    markLaunchPending()
    writeManagedSession(secondRelativePath, '{"id":"b"}\n')
    fsMockState.failAuditWrites = true

    const interrupted = await startCodexSessionBackfillInBackground()

    expect(interrupted).toMatchObject({ linkedFiles: 1, failedHealAuditRecords: 1 })
    expect(readMarker()).toMatchObject({ pendingScanDates: [FIXTURE_LAUNCH_DATE] })
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
    expect(readMarker()).toMatchObject({ version: 4 })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
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
})
