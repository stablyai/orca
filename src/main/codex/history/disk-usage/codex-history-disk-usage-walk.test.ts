import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { measureCodexHistoryDiskUsage } from './codex-history-disk-usage-walk'

const roots: string[] = []
const open = { maxEntries: 10_000, deadline: Number.MAX_SAFE_INTEGER }

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
    rmSync(root, { recursive: true, force: true })
  }
})

describe('measureCodexHistoryDiskUsage', () => {
  // File symlinks need elevation on Windows.
  it.skipIf(process.platform === 'win32')('counts each rollout file once and never through a link', () => {
    const root = tempRoot()
    const store = join(root, 'store', 'sessions')
    const account = join(root, 'account')
    const day = join('2026', '11', '01')
    write(join(store, day, 'rollout-a.jsonl'), 100)
    write(join(store, day, 'rollout-b.jsonl.zst'), 40)
    write(join(store, day, 'notes.txt'), 7)
    // Account history shared with the store: the same folder by a second path.
    mkdirSync(account, { recursive: true })
    symlinkSync(store, join(account, 'sessions'), 'dir')
    // A hard link in another home is the same file.
    const archived = join(root, 'store', 'archived_sessions')
    mkdirSync(archived, { recursive: true })
    linkSync(join(store, day, 'rollout-a.jsonl'), join(archived, 'rollout-a.jsonl'))
    write(join(account, '.orca-set-aside-rollouts', 'sessions', day, 'rollout-c.jsonl'), 20)
    // A symlinked log is skipped even when it points outside history.
    write(join(root, 'elsewhere', 'rollout-d.jsonl'), 5000)
    symlinkSync(join(root, 'elsewhere', 'rollout-d.jsonl'), join(store, day, 'rollout-d.jsonl'))

    expect(
      measureCodexHistoryDiskUsage(
        [
          store,
          join(account, 'sessions'),
          archived,
          join(account, '.orca-set-aside-rollouts'),
          join(root, 'missing')
        ],
        open,
        'win32'
      )
    ).toEqual({ bytes: 160, rollouts: 3, complete: true })
  })

  it('stops at its entry budget and reports a lower bound', () => {
    const root = tempRoot()
    for (const name of ['a', 'b', 'c']) {
      write(join(root, `rollout-${name}.jsonl`), 10)
    }

    expect(
      measureCodexHistoryDiskUsage([root], { ...open, maxEntries: 2 }, 'win32').complete
    ).toBe(false)
  })

  // What the disk gives back is whole blocks, not the bytes written.
  it.skipIf(process.platform === 'win32')('counts allocated blocks off Windows', () => {
    const root = tempRoot()
    write(join(root, 'rollout-a.jsonl'), 1)

    const { bytes } = measureCodexHistoryDiskUsage([root], open)
    expect(bytes).toBeGreaterThanOrEqual(512)
    expect(bytes % 512).toBe(0)
  })
})
