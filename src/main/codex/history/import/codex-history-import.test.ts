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
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdCodexRolloutForDeletion } from '../rollouts/codex-rollout-deletion-guard'
import { importCodexHistory } from './codex-history-import'

// The rollout whose copy finds the store's disk full.
const diskFull = vi.hoisted(() => ({ forName: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    copyFile: (...args: Parameters<typeof actual.copyFile>) =>
      basename(String(args[0])) === diskFull.forName
        ? Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }))
        : actual.copyFile(...args)
  }
})

const DAY = join('sessions', '2026', '11', '18')
const NEW = 'rollout-2026-11-18T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51.jsonl'
const TAKEN = 'rollout-2026-11-18T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52.jsonl'
const COMPRESSED = 'rollout-2026-11-18T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53.jsonl'
const ARCHIVED = 'rollout-2026-10-02T09-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a54.jsonl'
const LATER = 'rollout-2026-11-18T13-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a55.jsonl'

const roots: string[] = []

afterEach(() => {
  diskFull.forName = ''
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function setup(beforePublish: () => Promise<void> = async () => {}): {
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
  const run = (): Promise<number | null> =>
    importCodexHistory({
      importHome,
      storeHome,
      ledgerPath: join(root, 'import-ledger.json'),
      indexPendingDir: join(root, 'index-pending'),
      runId: 'testrun',
      isCurrent: () => true,
      waitForLaunches: async () => {},
      publish: async (job) => {
        await beforePublish()
        return job()
      }
    })
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

  it('does not publish a conversation deleted while it was copied', async () => {
    let deleting = true
    // A deletion already under way when its copy starts finishes before the publish.
    let underWay: (() => void) | null = null
    const { importHome, storeHome, run } = setup(async () => {
      if (deleting) {
        deleting = false
        ;(await holdCodexRolloutForDeletion(join(storeHome, DAY, NEW)))()
      }
      underWay?.()
      underWay = null
    })
    writeFileSync(join(importHome, DAY, NEW), 'new\n')

    expect(await run()).toBe(0)
    expect(readdirSync(join(storeHome, DAY))).toEqual([])
    expect(await run()).toBe(1)
    expect(readFileSync(join(storeHome, DAY, NEW), 'utf8')).toBe('new\n')

    writeFileSync(join(importHome, DAY, LATER), 'later\n')
    const release = await holdCodexRolloutForDeletion(join(storeHome, DAY, LATER))
    underWay = release
    expect(await run()).toBe(0)
    release()
    expect(existsSync(join(storeHome, DAY, LATER))).toBe(false)
  })

  it('imports the dated conversations when one archived rollout is unreadable', async () => {
    const { importHome, storeHome, run } = setup()
    writeFileSync(join(importHome, 'archived_sessions', ARCHIVED), 'archived\n')
    chmodSync(join(importHome, 'archived_sessions', ARCHIVED), 0o000)
    writeFileSync(join(importHome, DAY, NEW), 'new\n')

    await run()

    expect(readFileSync(join(storeHome, DAY, NEW), 'utf8')).toBe('new\n')
  })

  it('stops importing when the store disk is full', async () => {
    const { importHome, storeHome, run } = setup()
    writeFileSync(join(importHome, 'archived_sessions', ARCHIVED), 'archived\n')
    writeFileSync(join(importHome, DAY, NEW), 'new\n')
    diskFull.forName = ARCHIVED

    expect(await run()).toBe(0)

    expect(existsSync(join(storeHome, DAY, NEW))).toBe(false)
  })
})
