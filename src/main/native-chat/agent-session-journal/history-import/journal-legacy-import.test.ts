import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-import-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeFixture(name: string, lines: unknown[]): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
  return path
}

it.each([true, false])(
  'derives terminal proof for an imported OMP latest root from stopReason, completed: %s',
  async (completed) => {
    const filePath = await writeFixture('fork-tip.jsonl', [
      { type: 'session', id: 'omp-source', cwd: root },
      { type: 'message', id: 'u1', message: { role: 'user', content: 'First prompt' } },
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First response' }],
          stopReason: 'stop'
        }
      },
      { type: 'message', id: 'u2', message: { role: 'user', content: 'Latest prompt' } },
      {
        type: 'message',
        id: 'a2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Latest prose' }],
          ...(completed ? { stopReason: 'stop' } : {})
        }
      }
    ])
    const imported = await prepareLegacyTranscriptImport({
      agent: 'omp',
      sessionId: 'omp-source',
      options: { filePath }
    })
    expect(imported).toMatchObject({
      ok: true,
      forkTipItemIds: completed
        ? [
            agentJournalItemKey({
              provider: 'legacy',
              agent: 'omp',
              sessionId: 'omp-source',
              recordId: 'u2'
            }),
            agentJournalItemKey({
              provider: 'legacy',
              agent: 'omp',
              sessionId: 'omp-source',
              recordId: 'a2'
            })
          ]
        : []
    })
  }
)

it.each([
  { records: [], sourceEmpty: true },
  { records: [{ type: 'user', uuid: 'u1' }], sourceEmpty: false }
])(
  'reads a Claude file nothing was sent in as empty, unlike one with an undecodable turn: %j',
  async ({ records, sourceEmpty }) => {
    const filePath = await writeFixture('claude-unused.jsonl', [
      { type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: {} } },
      { type: 'summary', summary: 'New session', leafUuid: 'l1' },
      ...records
    ])
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'claude-unused',
      options: { filePath }
    })
    expect(prepared).toMatchObject({ ok: true, items: [], sourceEmpty })
  }
)
