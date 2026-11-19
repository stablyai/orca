import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importCodexHistory } from './codex-history-import'

const DAY = join('sessions', '2026', '11', '18')
const NEW = 'rollout-2026-11-18T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51.jsonl'
const TAKEN = 'rollout-2026-11-18T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52.jsonl'
const COMPRESSED = 'rollout-2026-11-18T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53.jsonl'
const ARCHIVED = 'rollout-2026-10-02T09-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a54.jsonl'
const LATER = 'rollout-2026-11-18T13-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a55.jsonl'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Launch checks made while a copy is staged don't count, so the chunk size doesn't matter.
function isStaging(storeHome: string): boolean {
  return readdirSync(join(storeHome, DAY)).some((name) => name.startsWith('.orca-import-'))
}

function setup(stopAfterChecks = Infinity): {
  importHome: string
  storeHome: string
  run: () => Promise<number | null>
} {
  const root = mkdtempSync(join(tmpdir(), 'codex-import-'))
  roots.push(root)
  const importHome = join(root, 'old-codex')
  const storeHome = join(root, '.codex')
  mkdirSync(join(importHome, DAY), { recursive: true })
  mkdirSync(join(importHome, 'archived_sessions'), { recursive: true })
  mkdirSync(join(storeHome, DAY), { recursive: true })
  const run = (): Promise<number | null> => {
    let checks = 0
    return importCodexHistory({
      importHome,
      storeHome,
      ledgerPath: join(root, 'import-ledger.json'),
      indexPendingDir: join(root, 'index-pending'),
      shouldStop: () => !isStaging(storeHome) && ++checks > stopAfterChecks
    })
  }
  return { importHome, storeHome, run }
}

describe('importCodexHistory', () => {
  it('copies missing rollouts without touching the import folder, and any store form wins', async () => {
    const { importHome, storeHome, run } = setup()
    const imported = join(importHome, DAY, NEW)
    writeFileSync(imported, 'new\n')
    const sourceTime = new Date('2026-03-01T00:00:00Z')
    utimesSync(imported, sourceTime, sourceTime)
    writeFileSync(join(importHome, DAY, TAKEN), 'import copy\n')
    writeFileSync(join(storeHome, DAY, TAKEN), 'store copy\n')
    // The store's compressed form wins even over a newer plain form here.
    writeFileSync(join(importHome, DAY, COMPRESSED), 'newer plain\n')
    writeFileSync(join(storeHome, DAY, `${COMPRESSED}.zst`), 'older compressed')
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    utimesSync(join(storeHome, DAY, `${COMPRESSED}.zst`), older, older)
    utimesSync(join(importHome, DAY, COMPRESSED), newer, newer)
    writeFileSync(join(importHome, 'archived_sessions', ARCHIVED), 'archived\n')

    expect(await run()).toBe(2)

    const copy = join(storeHome, DAY, NEW)
    expect(statSync(copy).ino).not.toBe(statSync(imported).ino)
    expect(readFileSync(copy, 'utf8')).toBe('new\n')
    expect(statSync(copy).mtimeMs).toBe(sourceTime.getTime())
    appendFileSync(copy, 'continued in Orca\n')
    expect(readFileSync(imported, 'utf8')).toBe('new\n')
    expect(readFileSync(join(storeHome, 'archived_sessions', ARCHIVED), 'utf8')).toBe('archived\n')
    expect(readFileSync(join(storeHome, DAY, TAKEN), 'utf8')).toBe('store copy\n')
    expect(existsSync(join(storeHome, DAY, COMPRESSED))).toBe(false)
    expect(readdirSync(join(storeHome, '..', 'index-pending')).sort()).toEqual(
      [ARCHIVED, NEW].sort()
    )
  })

  it('does not bring back a deleted conversation that Codex archived and compressed', async () => {
    const { importHome, storeHome, run } = setup()
    writeFileSync(join(importHome, DAY, NEW), 'new\n')
    expect(await run()).toBe(1)

    rmSync(join(storeHome, DAY, NEW))
    // Codex outside Orca archives it in the import folder, then compresses it.
    renameSync(join(importHome, DAY, NEW), join(importHome, 'archived_sessions', `${NEW}.zst`))
    writeFileSync(join(importHome, DAY, LATER), 'later\n')
    // Any mtime other than the one recorded marks the folders changed.
    const later = new Date('2030-01-01T00:00:00Z')
    utimesSync(join(importHome, DAY), later, later)
    utimesSync(join(importHome, 'archived_sessions'), later, later)

    expect(await run()).toBe(1)
    expect(existsSync(join(storeHome, DAY, NEW))).toBe(false)
    expect(existsSync(join(storeHome, 'archived_sessions', `${NEW}.zst`))).toBe(false)
    expect(readFileSync(join(storeHome, DAY, LATER), 'utf8')).toBe('later\n')
  })

  it('keeps progress across passes a launch stops, with both forms of each conversation here', async () => {
    // Each pass checks for a launch once per folder before its first conversation, so it copies one.
    const { importHome, storeHome, run } = setup(3)
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    for (const name of [NEW, TAKEN, COMPRESSED]) {
      writeFileSync(join(importHome, DAY, `${name}.zst`), 'compressed')
      writeFileSync(join(importHome, DAY, name), 'plain with later turns\n')
      utimesSync(join(importHome, DAY, `${name}.zst`), older, older)
      utimesSync(join(importHome, DAY, name), newer, newer)
    }

    expect(await run()).toBeNull()
    expect(await run()).toBeNull()
    expect(await run()).toBe(1)

    expect(readdirSync(join(storeHome, DAY)).sort()).toEqual([COMPRESSED, NEW, TAKEN].sort())
    expect(readFileSync(join(storeHome, DAY, TAKEN), 'utf8')).toBe('plain with later turns\n')
  })

  it('imports the dated conversations when one archived rollout is unreadable', async () => {
    const { importHome, storeHome, run } = setup()
    writeFileSync(join(importHome, 'archived_sessions', ARCHIVED), 'archived\n')
    chmodSync(join(importHome, 'archived_sessions', ARCHIVED), 0o000)
    writeFileSync(join(importHome, DAY, NEW), 'new\n')

    await run()

    expect(readFileSync(join(storeHome, DAY, NEW), 'utf8')).toBe('new\n')
  })
})
