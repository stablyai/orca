import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectAgentStorage } from './agent-storage-overview'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('counts shared provider history once, keeps per-path totals, and does not follow outside symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-storage-overview-'))
  const outside = await mkdtemp(join(tmpdir(), 'orca-storage-outside-'))
  roots.push(root, outside)
  const accounts = join(root, 'codex-accounts')
  await mkdir(accounts)
  const original = join(accounts, 'session-a.jsonl')
  await writeFile(original, 'x'.repeat(1024 * 1024))
  await link(original, join(accounts, 'session-b.jsonl'))
  await writeFile(join(outside, 'private-data'), 'x'.repeat(2 * 1024 * 1024))
  await symlink(
    outside,
    join(accounts, 'outside'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const originalInfo = await lstat(original)
  const bytes =
    typeof originalInfo.blocks === 'number' ? originalInfo.blocks * 512 : originalInfo.size
  const overview = await inspectAgentStorage(root)
  const account = overview.entries.find((entry) => entry.name === 'codex-accounts')
  expect(account).toBeDefined()
  expect((account?.referencedBytes ?? 0) - (account?.uniqueAllocatedBytes ?? 0)).toBe(bytes)
  expect(account?.uniqueAllocatedBytes).toBeLessThan(2 * 1024 * 1024)
  expect(overview.totals.skippedEntries).toBe(0)
})
