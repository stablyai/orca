import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { SessionSearchCatalog } from './session-search-catalog'
import { openSessionSearchIndexerHarness } from './indexing/session-search-indexer-test-fixture'

it.each([40, 400])(
  'charges refused directory attempts to the expired %s-directory discovery budget',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-refused-budget')
    const root = harness.claudeProjectDir
    for (let index = 0; index < population; index++) {
      await mkdir(join(root, `child-${index}`), { recursive: true })
    }
    const inventory = harness.inventory(root)
    let dispatching = false,
      dispatchRows = 0,
      dispatchEnvelopes = 0,
      dispatchCycles = 0
    const execute = SessionSearchCatalog.prototype.execute
    const response = SessionSearchCatalog.prototype.response
    const local = vi.spyOn(SessionSearchCatalog.prototype, 'execute').mockImplementation(function (
      this: SessionSearchCatalog,
      command
    ) {
      const result = execute.call(this, command)
      if (dispatching) {
        dispatchRows +=
          command.kind === 'put'
            ? command.rows.length
            : command.kind === 'get' || command.kind === 'delete'
              ? 1
              : command.kind === 'page'
                ? (result.rows?.length ?? 0)
                : 0
      }
      return result
    })
    const transport = vi
      .spyOn(SessionSearchCatalog.prototype, 'response')
      .mockImplementation(function (this: SessionSearchCatalog, command) {
        if (dispatching) {
          dispatchEnvelopes++
        }
        return response.call(this, command)
      })
    const retry = async () => {
      dispatching = true
      dispatchCycles++
      try {
        await inventory.retryFailures()
      } finally {
        dispatching = false
      }
    }
    const args = {
      rootDir: root,
      agent: 'claude' as const,
      limit: Infinity,
      extensions: ['.jsonl'],
      issues: []
    }
    await inventory.drain(args, () => true, 12)
    const actual = filesystem.wslGatedReaddir
    let refused = true
    const reads = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
      if (refused && path.startsWith(`${root}/`)) {
        return Promise.reject(
          Object.assign(new Error('fixture refused directory'), { code: 'EACCES' })
        )
      }
      return actual(path, ...rest)
    })
    try {
      await inventory.begin(false, args)
      await inventory.drain(args, () => reads.mock.calls.length > 0, 12)
      // Expire at the first actual observation; catalog-only continuation does not spend another attempt.
      expect(reads.mock.calls).toHaveLength(1)
      // Three refused observations per child, plus the root membership phases.
      for (let cycle = 0; cycle < 3 * population + 8 && inventory.pending; cycle++) {
        await inventory.begin(false, args)
        await retry()
        await inventory.drain(args, () => true, 12)
      }
      expect(inventory.pending).toBe(false)
      const heldAttempts = reads.mock.calls.length
      // A refusal enters and leaves ownership once per actual attempt; each local transfer touches at most twelve records, with eight fixed probes per dispatch.
      expect(dispatchRows).toBeLessThanOrEqual(
        12 * (population + heldAttempts) + 8 * dispatchCycles
      )
      // One dispatch per cycle and at most four handoffs per admitted 64-row page.
      expect(dispatchEnvelopes).toBeLessThanOrEqual(
        2 * dispatchCycles + 4 * Math.ceil((population + heldAttempts) / 64)
      )
      await inventory.begin(false, args)
      await retry()
      await inventory.drain(args, () => false, 12)
      expect(reads.mock.calls).toHaveLength(heldAttempts)
      refused = false
      const recovered = join(root, 'child-0', 'recovered.jsonl')
      await writeFile(recovered, '{}\n')
      await inventory.invalidate(join(root, 'child-0'))
      await inventory.begin(false, args)
      const result = await inventory.drain(args, () => false, 12)
      expect(result.changes.map((change) => change.file.path)).toContain(recovered)
    } finally {
      reads.mockRestore()
      local.mockRestore()
      transport.mockRestore()
      await harness.cleanup()
    }
  }
)

it('settles refused directory work after deletion completes across a discovery deadline', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-deleted-refused-directory')
  const root = harness.claudeProjectDir
  const child = join(root, 'refused')
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
