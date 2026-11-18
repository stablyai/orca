import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { measureCodexHistoryDiskUsage } from './codex-history-disk-usage-worker-entry'

const roots: string[] = []
const open = { maxEntries: 10_000, timeMs: 60_000 }
const day = join('2026', '11', '01')

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-history-usage-'))
  roots.push(root)
  return root
}

function write(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

// File symlinks need elevation on Windows; permission bits don't restrict reads there.
describe.skipIf(process.platform === 'win32')('measureCodexHistoryDiskUsage', () => {
  it('counts each rollout file once across homes and never through a link', () => {
    const root = tempRoot()
    const store = join(root, 'store')
    const account = join(root, 'account')
    write(join(store, 'sessions', day, 'rollout-a.jsonl'), 100)
    write(join(store, 'sessions', day, 'rollout-b.jsonl.zst'), 40)
    write(join(store, 'sessions', day, 'notes.txt'), 7)
    // Account history shared with the store: the same folder by a second path.
    mkdirSync(account, { recursive: true })
    symlinkSync(join(store, 'sessions'), join(account, 'sessions'), 'dir')
    // A hard link in another folder is the same file.
    mkdirSync(join(store, 'archived_sessions'), { recursive: true })
    linkSync(
      join(store, 'sessions', day, 'rollout-a.jsonl'),
      join(store, 'archived_sessions', 'rollout-a.jsonl')
    )
    write(join(account, '.orca-set-aside-rollouts', 'sessions', day, 'rollout-c.jsonl'), 20)
    write(join(account, 'sessions.1794945314.orca-profile-merge', day, 'rollout-e.jsonl'), 9)
    // A symlinked log is skipped even when it points outside history.
    write(join(root, 'elsewhere', 'rollout-d.jsonl'), 5000)
    symlinkSync(
      join(root, 'elsewhere', 'rollout-d.jsonl'),
      join(store, 'sessions', day, 'rollout-d.jsonl')
    )

    expect(
      measureCodexHistoryDiskUsage([store, account, join(root, 'missing')], open, 'win32')
    ).toEqual({ bytes: 169, rollouts: 4, complete: true })
  })

  it('reports a lower bound when a folder cannot be read or the budget runs out', () => {
    const root = tempRoot()
    for (const name of ['a', 'b', 'c']) {
      write(join(root, 'sessions', `rollout-${name}.jsonl`), 10)
    }
    // Listing the home, its three history folders and opening sessions take 5 steps; the budget
    // runs out after the first rollout, which still counts.
    expect(measureCodexHistoryDiskUsage([root], { ...open, maxEntries: 6 }, 'win32')).toEqual({
      bytes: 10,
      rollouts: 1,
      complete: false
    })

    // Root reads through permission bits.
    if (process.getuid?.() === 0) {
      return
    }
    chmodSync(join(root, 'sessions'), 0o000)
    try {
      expect(measureCodexHistoryDiskUsage([root], open, 'win32').complete).toBe(false)
    } finally {
      chmodSync(join(root, 'sessions'), 0o700)
    }
  })

  // What the disk gives back is whole blocks, not the bytes written.
  it('counts allocated blocks off Windows', () => {
    const root = tempRoot()
    write(join(root, 'sessions', 'rollout-a.jsonl'), 1)

    const { bytes } = measureCodexHistoryDiskUsage([root], open)
    expect(bytes).toBeGreaterThanOrEqual(512)
    expect(bytes % 512).toBe(0)
  })
})
