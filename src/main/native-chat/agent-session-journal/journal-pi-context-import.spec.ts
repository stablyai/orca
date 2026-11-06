import './journal-legacy-import-worker.mock-fixture'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importLegacyTranscriptIntoJournal,
  prepareLegacyTranscriptImport
} from './journal-legacy-import'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
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

    it('persists compaction and branch summaries in the adopted journal across reopen', async () => {
      const fixture = PI_CONTEXT_FIXTURES[0]
      if (!fixture) {
        throw new Error('missing compaction fixture')
      }
      const expected = await prepare([
        ...fixture.entries,
        {
          type: 'branch_summary',
          id: 'branch',
          parentId: 'later',
          fromId: 'discarded',
          summary: 'Saved branch details.'
        }
      ])
      const filePath = join(root, 'session.jsonl')
      const options = {
        stateDirectory: join(root, 'journal'),
        identity: {
          sessionId: 'native-chat',
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'pi' as const,
          providerHandle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: filePath }
        }
      }
      const journal = await journals.open(options)
      expect(
        await importLegacyTranscriptIntoJournal({
          journal,
          agent: 'pi',
          sessionId: 'session',
          fence: 1,
          options: { filePath }
        })
      ).toMatchObject({ ok: true, imported: 4, replaced: true })
      await journal.close()
      const reopened = await journals.open(options)
      expect(reopened.snapshot().items.map((item) => item.body)).toEqual(
        expected.map((item) => item.body)
      )
      expect(JSON.stringify(reopened.snapshot().items)).toContain('Saved branch details.')
    })
  })
}
