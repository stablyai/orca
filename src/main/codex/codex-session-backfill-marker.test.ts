import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { startCodexSessionBackfillInBackground } from './codex-session-backfill'
import { markCodexSessionBackfillPending } from './codex-session-backfill-marker'

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

function writeManagedSession(relativePath: string): void {
  const filePath = join(getManagedSessionsRoot(), relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, '{"id":"a"}\n', 'utf-8')
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-marker-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-marker-user-data-'))
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

describe('Codex session backfill marker', () => {
  it('keeps a new launch generation from letting an older scan confirm completion', async () => {
    writeManagedSession(join('2026', '08', '05', 'rollout-a.jsonl'))
    let launchRecorded = false

    const raced = await startCodexSessionBackfillInBackground({
      shouldStop: () => {
        if (!launchRecorded) {
          launchRecorded = true
          markCodexSessionBackfillPending(getMarkerPath(), getSystemSessionsRoot(), [
            '2026',
            '08',
            '05'
          ])
        }
        return false
      }
    })

    expect(raced).toMatchObject({ linkedFiles: 1 })
    const marker = JSON.parse(readFileSync(getMarkerPath(), 'utf-8')) as Record<string, unknown>
    expect(marker).toMatchObject({ version: 4, pendingSince: '2026-08-05' })
    expect(marker).not.toHaveProperty('baseline')
  })

  it('migrates a v3 baseline and records a launch without deleting it', () => {
    mkdirSync(dirname(getMarkerPath()), { recursive: true })
    writeFileSync(
      getMarkerPath(),
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: getSystemSessionsRoot(),
        completedAt: 1,
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )

    expect(
      markCodexSessionBackfillPending(getMarkerPath(), getSystemSessionsRoot(), [
        '2026',
        '08',
        '05'
      ])
    ).toBe(false)
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({
      version: 4,
      baseline: { summary: { scannedFiles: 1 } },
      pendingSince: '2026-08-05'
    })
  })

  it('clears pendingSince after a successful bounded confirmation', async () => {
    writeManagedSession(join('2026', '08', '05', 'rollout-a.jsonl'))
    await startCodexSessionBackfillInBackground()
    markCodexSessionBackfillPending(getMarkerPath(), getSystemSessionsRoot(), ['2026', '08', '05'])

    await startCodexSessionBackfillInBackground({
      ignoreCompletionMarker: true,
      scanDates: [['2026', '08', '05']],
      writeBoundedCompletionMarker: true
    })

    const marker = JSON.parse(readFileSync(getMarkerPath(), 'utf-8')) as Record<string, unknown>
    expect(marker).toMatchObject({ version: 4, baseline: { summary: { scannedFiles: 1 } } })
    expect(marker).not.toHaveProperty('pendingSince')
  })
})
