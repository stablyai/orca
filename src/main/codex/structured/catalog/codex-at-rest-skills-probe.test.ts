import type * as Files from 'node:fs/promises'
import { scanClaudeCommandFolders } from '../../../claude/claude-command-folder-scan'
import type * as Catalog from '../../../native-chat/agent-session-wire/at-rest-command-catalog'
import { afterEach, expect, it, vi } from 'vitest'

const folders = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Files>()),
  opendir: folders.open,
  readFile: folders.read,
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
afterEach(() => vi.useRealTimers())

const visits = vi.hoisted(() => vi.fn((current: boolean) => current))
vi.mock('../../../native-chat/agent-session-wire/at-rest-command-catalog', async (original) => {
  const actual = await original<typeof Catalog>()
  return {
    ...actual,
    AtRestCommandCatalog: vi.fn(function (source: Catalog.AtRestCommandSource) {
      return new actual.AtRestCommandCatalog({
        ...source,
        scan: (record, cwd, current, ...rest) =>
          source.scan(record, cwd, () => visits(current()), ...rest)
      })
    })
  }
})

it('closes a directory opened after cancellation before any read or recursion', async () => {
  const opened = Promise.withResolvers<unknown>()
  const next = vi.fn(() => new Promise<IteratorResult<never>>(() => {}))
  const close = vi.fn(async () => undefined)
  folders.open.mockReturnValueOnce(opened.promise)
  const stop = new AbortController()
  const reading = scanClaudeCommandFolders(['/commands'], stop.signal)
  const rejected = expect(reading).rejects.toThrow('cancelled')
  stop.abort(new Error('cancelled'))
  opened.resolve({ close, [Symbol.asyncIterator]: () => ({ next }) })
  await rejected
  expect(close).toHaveBeenCalledExactlyOnceWith()
  expect(next).not.toHaveBeenCalled()
  expect(folders.open).toHaveBeenCalledExactlyOnceWith('/commands')
  expect(folders.read).not.toHaveBeenCalled()
})
