import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { SessionSearchStore } from './session-search-store'
import {
  assistantRecord,
  CLAUDE_SESSION_ID as SESSION_ID,
  CODEX_ROLLOUT_FILE,
  CODEX_SESSION_ID,
  codexRolloutLines,
  parseTranscript,
  userRecord
} from './session-search-transcript-fixtures'

let tempRoots: string[] = []
let store: SessionSearchStore

beforeEach(async () => {
  resetSessionParseCacheForTests()
  const root = await makeTempDir()
  store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  registerSessionSearchIndexSink(store)
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-chunking-'))
  tempRoots.push(root)
  return root
}

/** `lines` × 100 chars each, with `markers` (word, char offset) planted in place. */
function paddedText(lines: number, markers: { word: string; offset: number }[]): string {
  const out: string[] = []
  for (let index = 0; index < lines; index += 1) {
    const marker = markers.find((entry) => Math.floor(entry.offset / 100) === index)
    const body = marker ? `${marker.word} ` : ''
    out.push(`${body}line${index} ${'padding '.repeat(20)}`.slice(0, 99))
  }
  return `${out.join('\n')}\n`
}

describe('session search chunking and coverage', () => {
  it('splits a 30 KB assistant message into rows that all stay on one session', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    // 300 × 100-char lines: chunks land on the 8000-char line boundaries exactly.
    const long = paddedText(300, [{ word: 'zygomorphic', offset: 26_500 }])
    expect(long.length).toBe(30_000)
    await writeFile(
      path,
      `${[userRecord(0, 'summarize the log'), assistantRecord(1, long)].join('\n')}\n`
    )
    await parseTranscript(path)

    // 8000 + 8000 + 8000 + 6000, plus the one user message.
    expect(store.coverage()).toMatchObject({ sessionsIndexed: 1, messagesIndexed: 5 })
    // A term in the last 5 KB is only reachable because the tail is its own row.
    const tail = store.search({ query: 'zygomorphic' })
    expect(tail.hits).toHaveLength(1)
    expect(tail.hits[0]).toMatchObject({ sessionId: SESSION_ID, evidence: { role: 'assistant' } })
  })

  it('caps a 100 KB tool output at 3 KB', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    const output = paddedText(1000, [
      { word: 'earlyneedle', offset: 2000 },
      { word: 'lateneedle', offset: 4000 }
    ])
    expect(output.length).toBe(100_000)
    await writeFile(
      path,
      `${[
        userRecord(0, 'run the suite'),
        userRecord(1, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }])
      ].join('\n')}\n`
    )
    await parseTranscript(path)

    expect(store.search({ query: 'earlyneedle' }).hits).toHaveLength(1)
    expect(store.search({ query: 'lateneedle' }).hits).toHaveLength(0)
    // One user row plus one tool row: the cap lands inside a single chunk.
    expect(store.coverage().messagesIndexed).toBe(2)
  })

  it('counts coverage per provider and indexes Codex CommandExecution as tool rows', async () => {
    const root = await makeTempDir()
    const claudePath = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(claudePath, `${userRecord(0, 'claude side question')}\n`)
    await parseTranscript(claudePath)

    const codexPath = join(root, CODEX_ROLLOUT_FILE)
    await writeFile(
      codexPath,
      `${codexRolloutLines(
        ['pnpm', 'test', 'src/main/ai-vault-search'],
        'FAIL src/main/ai-vault-search/quixotic.test.ts',
        'codex side question'
      ).join('\n')}\n`
    )
    await parseTranscript(codexPath, 'codex')

    expect(store.coverage()).toMatchObject({
      sessionsIndexed: 2,
      // claude: 1 prompt. codex: 1 prompt + command + aggregated output.
      messagesIndexed: 4,
      providers: [
        { agent: 'claude', sessionsIndexed: 1, messagesIndexed: 1 },
        { agent: 'codex', sessionsIndexed: 1, messagesIndexed: 3 }
      ]
    })

    const command = store.search({ query: 'pnpm test src/main/ai-vault-search' })
    expect(command.hits).toHaveLength(1)
    expect(command.hits[0]).toMatchObject({
      agent: 'codex',
      sessionId: CODEX_SESSION_ID,
      evidence: { role: 'tool' }
    })
    const output = store.search({ query: 'quixotic' })
    expect(output.hits[0]).toMatchObject({ agent: 'codex', evidence: { role: 'tool' } })
  })
})
