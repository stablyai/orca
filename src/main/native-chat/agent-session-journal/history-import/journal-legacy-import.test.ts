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
  { tail: '', sourceEmpty: true, items: 0 },
  { tail: '{"type":"future-metadata"}', sourceEmpty: true, items: 0 },
  { tail: '{"message":{"role":"user","content":"existing prompt"}}', sourceEmpty: false, items: 0 },
  {
    tail: '{"type":"future-turn","message":{"role":"user","content":"existing prompt"}}',
    sourceEmpty: false,
    items: 0
  },
  { tail: '{"type":"summary","message":null}', sourceEmpty: false, items: 0 },
  { tail: '{"type":"user","uuid":"u1"}', sourceEmpty: false, items: 0 },
  { tail: '{"type":7}', sourceEmpty: false, items: 0 },
  { tail: '{"type":""}', sourceEmpty: false, items: 0 },
  { tail: '{}', sourceEmpty: false, items: 0 },
  { tail: 'null', sourceEmpty: false, items: 0 },
  { tail: '[]', sourceEmpty: false, items: 0 },
  { tail: '{"type":"user","message":{"role":"us', sourceEmpty: false, items: 0 },
  {
    tail: '{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Local command</local-command-caveat>"}}',
    sourceEmpty: true,
    items: 0
  },
  {
    tail: '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"saved output"}]}}',
    sourceEmpty: false,
    items: 1,
    shows: 'saved output'
  },
  {
    tail: '{"type":"user","message":{"role":"user","content":"<command-name>/rename</command-name>"}}',
    sourceEmpty: false,
    items: 1,
    shows: '<command-name>/rename</command-name>'
  },
  {
    tail: '{"type":"user","message":{"role":"user","content":[{"type":"future-content","text":"existing prompt"}]}}',
    sourceEmpty: false,
    items: 0
  }
])(
  'reads a Claude file nothing was sent in as empty, unlike one with a turn it cannot decode: %j',
  async ({
    tail,
    sourceEmpty,
    items,
    shows
  }: {
    tail: string
    sourceEmpty: boolean
    items: number
    shows?: string
  }) => {
    const filePath = join(root, 'claude-unused.jsonl')
    const metadata = [
      { type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: {} } },
      {
        type: 'summary',
        summary: 'New session',
        leafUuid: 'l1',
        cwd: root,
        sessionId: 'claude-unused'
      }
    ]
    await writeFile(filePath, `${[...metadata.map((m) => JSON.stringify(m)), tail].join('\n')}\n`)
    // Adoption always names the conversation it expects, as Continue in Chat's create does.
    const source = { providerSessionId: 'claude-unused', workspaceCwd: root }
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'claude-unused',
      options: { filePath, source }
    })
    expect(prepared.ok).toBe(true)
    expect(prepared.ok && prepared.items.length).toBe(items)
    if (shows) {
      expect(JSON.stringify(prepared.ok && prepared.items)).toContain(shows)
    }
    expect(prepared.ok && prepared.sourceEmpty).toBe(sourceEmpty)
  }
)
