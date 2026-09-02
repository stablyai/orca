import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import {
  registerSessionSearchIndexSink,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import { SessionSearchStore } from './session-search-store'
import {
  assistantRecord,
  CLAUDE_SESSION_ID as SESSION_ID,
  parseTranscript as parse,
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
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-'))
  tempRoots.push(root)
  return root
}

describe('SessionSearchStore', () => {
  it('indexes a transcript through the parse cache and finds it by mid-session text', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      path,
      `${[
        userRecord(0, 'first question about the tab switcher'),
        assistantRecord(1, [{ type: 'text', text: 'Looking at resolveTerminalPath now.' }]),
        userRecord(2, 'the locator is flaky again'),
        assistantRecord(3, [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'pnpm test src/tabs' }
          }
        ]),
        userRecord(4, [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'Error: strict mode violation: getByRole(button) resolved to 2 elements'
          }
        ]),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Fix flaky locator' })
      ].join('\n')}\n`
    )
    await parse(path)

    const literal = store.search({ query: 'strict mode violation getByRole' })
    expect(literal.hits).toHaveLength(1)
    expect(literal.hits[0]).toMatchObject({
      agent: 'claude',
      sessionId: SESSION_ID,
      title: 'Fix flaky locator',
      cwd: '/repo/app',
      evidence: { role: 'tool' }
    })
    expect(literal.hits[0]?.evidence.snippet).toContain('[strict]')
    expect(literal.route).toBe('phrase')

    // Identifier split: a partial camelCase name still matches.
    expect(store.search({ query: 'TerminalPath' }).hits).toHaveLength(1)
    // Tool command indexed from the tool_use block.
    expect(store.search({ query: 'pnpm test src/tabs' }).hits).toHaveLength(1)
    // Conversation tier excludes tool rows but keeps prompts.
    expect(store.search({ query: 'getByRole', tier: 'conversation' }).hits).toHaveLength(0)
    expect(store.search({ query: 'locator flaky', tier: 'conversation' }).hits).toHaveLength(1)
    // user, assistant, user, tool_use, tool_result
    expect(store.coverage()).toMatchObject({ sessionsIndexed: 1, messagesIndexed: 5 })
  })

  it('appends only the new lines on an incremental parse and keeps the cursor in step', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(path, `${userRecord(0, 'alpha question')}\n`)
    await parse(path)
    expect(store.search({ query: 'omega' }).hits).toHaveLength(0)

    await appendFile(path, `${assistantRecord(1, 'omega answer')}\n`)
    const { stats } = await parse(path)
    expect(stats.incremental).toBe(1)
    expect(store.search({ query: 'omega' }).hits).toHaveLength(1)
    expect(store.search({ query: 'alpha' }).hits).toHaveLength(1)
    expect(store.coverage().messagesIndexed).toBe(2)
  })

  it('re-indexes a rename-replaced file instead of appending onto stale rows', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(path, `${userRecord(0, 'stale question')}\n`)
    await parse(path)

    const staging = join(root, 'staging.jsonl')
    await writeFile(
      staging,
      `${userRecord(0, 'fresh question')}\n${assistantRecord(1, 'fresh answer')}\n`
    )
    await rename(staging, path)
    await parse(path)

    expect(store.search({ query: 'stale' }).hits).toHaveLength(0)
    expect(store.search({ query: 'fresh' }).hits).toHaveLength(1)
    expect(store.coverage().messagesIndexed).toBe(2)
  })

  it('marks a cache-known file stale in opportunistic mode and re-parses it in required mode', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(path, `${userRecord(0, 'before the index existed')}\n`)
    registerSessionSearchIndexSink(null)
    await parse(path)
    expect(store.coverage().sessionsIndexed).toBe(0)

    // A list scan must not pay for the index: reuse the cache, queue the file.
    registerSessionSearchIndexSink(store)
    const opportunistic = await parse(path)
    expect(opportunistic.stats.reused).toBe(1)
    expect(store.coverage()).toMatchObject({ sessionsIndexed: 0, filesPending: 1 })

    // The backfill lane drains the queue with a whole-file parse.
    const stale = store.takeStale()
    expect(stale.map((candidate) => candidate.file.path)).toEqual([path])
    const required = await withSessionSearchIndexRequired(() => parse(path))
    expect(required.stats.reused).toBe(0)
    expect(store.search({ query: 'before the index existed' }).hits).toHaveLength(1)
    expect(store.coverage().filesPending).toBe(0)
  })

  it('repairs a typo from the index vocabulary', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(
      path,
      `${userRecord(0, 'the watcher coalesces events')}\n${assistantRecord(1, 'watcher coalesces them')}\n`
    )
    await parse(path)
    const result = store.search({ query: 'watcher coalesces' })
    expect(result.hits).toHaveLength(1)
    const typo = store.search({ query: 'watcher coalesces'.replace('coalesces', 'coalesecs') })
    expect(typo.hits).toHaveLength(1)
    expect(typo.route).toMatch(/^typo\+/)
    expect(typo.repairedTerms).toContain('coalesces')
  })

  it('ranks by newest when asked and filters by agent and scope', async () => {
    const root = await makeTempDir()
    const older = join(root, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const newer = join(root, 'aaaaaaaa-0000-4000-8000-000000000002.jsonl')
    await writeFile(
      older,
      `${userRecord(0, 'shared phrase one', 'aaaaaaaa-0000-4000-8000-000000000001')}\n`
    )
    await writeFile(
      newer,
      `${userRecord(500, 'shared phrase two', 'aaaaaaaa-0000-4000-8000-000000000002')}\n`
    )
    await parse(older)
    await parse(newer)
    const newest = store.search({ query: 'shared phrase', sort: 'newest' })
    expect(newest.hits.map((hit) => hit.sessionId)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001'
    ])
    expect(store.search({ query: 'shared phrase', agents: ['codex'] }).hits).toHaveLength(0)
    expect(store.search({ query: 'shared phrase', scopePaths: ['/repo'] }).hits).toHaveLength(2)
    expect(store.search({ query: 'shared phrase', scopePaths: ['/other'] }).hits).toHaveLength(0)
  })

  it('does not choke on FTS5 syntax in user text', async () => {
    const root = await makeTempDir()
    const path = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(path, `${userRecord(0, 'run cli.mjs with foo-bar and C++')}\n`)
    await parse(path)
    for (const query of ['cli.mjs', 'foo-bar', 'C++', '"quoted phrase"', 'AND OR NOT']) {
      expect(() => store.search({ query })).not.toThrow()
    }
    expect(store.search({ query: 'cli.mjs' }).hits).toHaveLength(1)
    expect(store.search({ query: 'foo-bar' }).hits).toHaveLength(1)
  })
})
