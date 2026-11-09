import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'
import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import './journal-pi-active-branch'
import { PI_CONTEXT_FIXTURES } from './journal-pi-context-fixtures'

export function registerJournalPiContextImportTests(): void {
  let root: string
  const journals = createTrackedJournalOpener()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-pi-context-'))
  })
  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  async function prepare(entries: unknown[], version = 3) {
    const filePath = join(root, 'session.jsonl')
    const header = { type: 'session', id: 'session', version, cwd: root }
    await writeFile(
      filePath,
      [JSON.stringify(header), '{bad json', ...entries.map((entry) => JSON.stringify(entry))].join(
        '\n'
      )
    )
    const result = await prepareLegacyTranscriptImport({
      agent: 'pi',
      sessionId: 'session',
      options: { filePath }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    return result.items
  }

  describe('saved Pi context import', () => {
    it('keeps prepared history when temporary database teardown reports an error', async () => {
      const close = Database.prototype.close
      const closeSpy = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
        this: Database.Database
      ) {
        close.call(this)
        throw new Error('test teardown failure')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const items = await prepare([
          {
            type: 'message',
            id: 'first',
            parentId: null,
            message: { role: 'user', content: 'hello' }
          }
        ])
        expect(items).toHaveLength(1)
        expect(items[0]?.identity).toMatchObject({ provider: 'legacy', recordId: 'first' })
        expect(warn).toHaveBeenCalledWith(
          '[journal-pi-import] temporary database close failed:',
          expect.objectContaining({ message: 'test teardown failure' })
        )
      } finally {
        closeSpy.mockRestore()
        warn.mockRestore()
      }
    })

    it.each(PI_CONTEXT_FIXTURES)('$name', async (fixture) => {
      const items = await prepare(fixture.entries, 'version' in fixture ? fixture.version : 3)
      expect(
        items.map((item) =>
          item.body.kind === 'message'
            ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
      ).toEqual(fixture.texts.map((text) => [text]))
    })

    it('selects saved compaction ancestry after a large inactive branch', async () => {
      const timestamp = '2026-10-12T12:00:00.000Z'
      const inactive = Array.from({ length: 950 }, (_, index) => ({
        type: 'message',
        id: `inactive-${index}`,
        parentId: index === 0 ? 'root' : `inactive-${index - 1}`,
        timestamp,
        message: { role: 'user', content: 'discarded '.concat('x'.repeat(18 * 1024)) }
      }))
      const items = await prepare([
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp,
          message: { role: 'user', content: 'root' }
        },
        ...inactive,
        {
          type: 'compaction',
          id: 'summary',
          parentId: 'root',
          firstKeptEntryId: 'root',
          summary: 'summary',
          timestamp
        },
        {
          type: 'message',
          id: 'latest',
          parentId: 'summary',
          timestamp,
          message: { role: 'assistant', content: 'latest' }
        }
      ])
      expect(
        items.flatMap((item) =>
          item.body.kind === 'message'
            ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
      ).toEqual(['summary', 'root', 'latest'])
    })
  })
}
