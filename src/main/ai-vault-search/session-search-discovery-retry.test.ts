import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { openSessionSearchIndexerHarness } from './indexing/session-search-indexer-test-fixture'

it('settles refused directory work after deletion completes across a discovery deadline', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-deleted-refused-directory')
  const root = harness.claudeProjectDir
  const child = join(root, '😀refused')
  const inventory = harness.inventory(root)
  const args = {
    rootDir: root,
    agent: 'claude' as const,
    extensions: ['.jsonl'],
    issues: [],
    limit: Infinity
  }
  const actual = filesystem.wslGatedReaddir
  let refused = true
  const reads = vi
    .spyOn(filesystem, 'wslGatedReaddir')
    .mockImplementation((path, ...rest) =>
      refused && path === child
        ? Promise.reject(Object.assign(new Error('fixture refused directory'), { code: 'EACCES' }))
        : actual(path, ...rest)
    )
  try {
    await mkdir(child, { recursive: true })
    await inventory.begin(false, args)
    await inventory.drain(args, () => false, 12)
    await rm(child, { recursive: true })
    refused = false
    await inventory.invalidate(child)
    for (let cycle = 0; cycle < 12 && inventory.pending; cycle++) {
      await inventory.begin(false, args)
      await inventory.retryFailures()
      await inventory.drain(args, () => true, 12)
    }
    expect(inventory.pending).toBe(false)
    const recovered = join(child, 'recovered.jsonl')
    await mkdir(child, { recursive: true })
    await writeFile(recovered, '{}\n')
    await inventory.invalidate(child)
    await inventory.begin(false, args)
    expect(
      (await inventory.drain(args, () => false, 12)).changes.map((change) => change.file.path)
    ).toContain(recovered)
  } finally {
    reads.mockRestore()
    await harness.cleanup()
  }
})
