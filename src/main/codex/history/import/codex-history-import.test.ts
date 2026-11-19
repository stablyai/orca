import {
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
const BOTH = 'rollout-2026-11-18T14-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a56.jsonl'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function setup(): { importHome: string; storeHome: string; run: () => Promise<number | null> } {
  const root = mkdtempSync(join(tmpdir(), 'codex-import-'))
  roots.push(root)
  const importHome = join(root, 'old-codex')
  const storeHome = join(root, '.codex')
  mkdirSync(join(importHome, DAY), { recursive: true })
  mkdirSync(join(importHome, 'archived_sessions'), { recursive: true })
  mkdirSync(join(storeHome, DAY), { recursive: true })
  const run = (): Promise<number | null> =>
    importCodexHistory({
      importHome,
      storeHome,
      ledgerPath: join(root, 'import-ledger.json'),
      indexPendingDir: join(root, 'index-pending'),
      shouldStop: () => false
    })
  return { importHome, storeHome, run }
}

describe('importCodexHistory', () => {
  it('links missing active and archived rollouts and never replaces the store’s own', async () => {
    const { importHome, storeHome, run } = setup()
    writeFileSync(join(importHome, DAY, NEW), 'new\n')
    writeFileSync(join(importHome, DAY, TAKEN), 'import copy\n')
    writeFileSync(join(storeHome, DAY, TAKEN), 'store copy\n')
    writeFileSync(join(importHome, DAY, COMPRESSED), 'old plain\n')
    writeFileSync(join(storeHome, DAY, `${COMPRESSED}.zst`), 'newer compressed')
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    utimesSync(join(importHome, DAY, COMPRESSED), older, older)
    utimesSync(join(storeHome, DAY, `${COMPRESSED}.zst`), newer, newer)
    // Both forms in the import folder: the plain one holds turns appended after compression.
    writeFileSync(join(importHome, DAY, `${BOTH}.zst`), 'compressed')
    writeFileSync(join(importHome, DAY, BOTH), 'compressed plus newer turns\n')
    utimesSync(join(importHome, DAY, `${BOTH}.zst`), older, older)
    utimesSync(join(importHome, DAY, BOTH), newer, newer)
    writeFileSync(join(importHome, 'archived_sessions', ARCHIVED), 'archived\n')

    expect(await run()).toBe(4)

    expect(statSync(join(storeHome, DAY, NEW)).ino).toBe(statSync(join(importHome, DAY, NEW)).ino)
    expect(readFileSync(join(storeHome, 'archived_sessions', ARCHIVED), 'utf8')).toBe('archived\n')
    expect(readFileSync(join(storeHome, DAY, TAKEN), 'utf8')).toBe('store copy\n')
    expect(existsSync(join(storeHome, DAY, COMPRESSED))).toBe(false)
    expect(readFileSync(join(storeHome, DAY, BOTH), 'utf8')).toBe('compressed plus newer turns\n')
    expect(readdirSync(join(storeHome, '..', 'index-pending')).sort()).toEqual(
      [ARCHIVED, BOTH, `${BOTH}.zst`, NEW].sort()
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
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(importHome, DAY), later, later)
    utimesSync(join(importHome, 'archived_sessions'), later, later)

    expect(await run()).toBe(1)
    expect(existsSync(join(storeHome, DAY, NEW))).toBe(false)
    expect(existsSync(join(storeHome, 'archived_sessions', `${NEW}.zst`))).toBe(false)
    expect(readFileSync(join(storeHome, DAY, LATER), 'utf8')).toBe('later\n')
  })
})
