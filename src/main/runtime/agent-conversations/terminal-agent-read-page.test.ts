import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentReadEntry } from '../../../shared/agent-conversations/agent-conversation-contracts'
import { readTerminalAgentPage, type TerminalAgentReadPage } from './terminal-agent-read-page'

const OWNER = '3540ecf3-47c3-4876-b825-81bf5d6b3595'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function transcriptFile(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-read-page-'))
  dirs.push(dir)
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
  return path
}

const message = (id: string, role: 'user' | 'assistant' = 'assistant') =>
  JSON.stringify({ type: role, uuid: id, message: { role, content: [{ type: 'text', text: id }] } })

/** Six blocks of text that JSON escapes to six bytes a character, so a page of them outgrows
 *  the response bound and its oldest messages are dropped. */
const heavyMessage = (id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: {
      role: 'assistant',
      content: Array.from({ length: 6 }, () => ({
        type: 'text',
        text: `${id} ${'\u0007'.repeat(2_000)}`
      }))
    }
  })

const metadata = (id: string) => JSON.stringify({ type: 'summary', summary: id, leafUuid: id })

function readPage(
  path: string,
  limit: number,
  cursor?: string,
  orcaSessionId = OWNER
): Promise<TerminalAgentReadPage> {
  return readTerminalAgentPage({
    orcaSessionId,
    agent: 'claude',
    sessionId: 'provider-session',
    transcriptPath: path,
    limit,
    ...(cursor !== undefined ? { cursor } : {})
  })
}

/** Every page from the newest to the one with no cursor; `between` runs after each page. */
async function readEveryPage(
  path: string,
  limit: number,
  between?: () => void
): Promise<TerminalAgentReadPage[]> {
  const pages: TerminalAgentReadPage[] = []
  let cursor: string | undefined
  while (pages.length < 200) {
    const page = await readPage(path, limit, cursor)
    pages.push(page)
    if (page.nextCursor === null) {
      return pages
    }
    cursor = page.nextCursor
    between?.()
  }
  throw new Error('paging did not end')
}

const MIB = 1024 * 1024
/** Non-message records filling `bytes`, longer than one scan window when over 8 MiB. */
const metadataStretch = (bytes: number) =>
  Array.from({ length: Math.ceil(bytes / 1_024) }, (_, index) =>
    JSON.stringify({ type: 'summary', summary: 'x'.repeat(1_000), leafUuid: `s${index}` })
  )

const idOf = (entry: AgentReadEntry) => (entry.kind === 'message' ? entry.text.split(' ')[0] : '')
const assembled = (pages: readonly TerminalAgentReadPage[]) =>
  pages.toReversed().flatMap((page) => page.entries.map(idOf))

describe('readTerminalAgentPage', () => {
  it('pages back to the start with every message once, in order, while the agent appends', async () => {
    const lines: string[] = []
    const ids: string[] = []
    for (let index = 0; index < 23; index++) {
      if (index % 4 === 0) {
        lines.push(metadata(`meta${index}`))
      }
      ids.push(`e${index}`)
      lines.push(message(`e${index}`, index % 2 === 0 ? 'user' : 'assistant'))
    }
    const path = transcriptFile(lines)
    let appended = 0
    const pages = await readEveryPage(path, 3, () => {
      appendFileSync(path, `${message(`new${appended++}`)}\n`)
    })

    expect(assembled(pages)).toEqual(ids)
    expect(pages.map((page) => page.entries.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 2])
    const fresh = await readPage(path, 3)
    expect(fresh.entries.map(idOf)).toEqual(['new4', 'new5', 'new6'])
  })

  it('keeps messages the response bound drops for the next page', async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `h${index}`)
    const path = transcriptFile(ids.map(heavyMessage))
    const pages = await readEveryPage(path, 20)

    expect(assembled(pages)).toEqual(ids)
    // The bound, not the limit of 20, ends each page before the last.
    expect(pages.map((page) => page.entries.length)).toEqual([12, 12, 12, 9])
    expect(pages.flatMap((page) => page.entries).every((entry) => entry.shortened)).toBe(true)
  })

  it('ends with no cursor where the first message follows leading metadata', async () => {
    const path = transcriptFile([
      metadata('a'),
      metadata('b'),
      metadata('c'),
      ...['e0', 'e1', 'e2', 'e3', 'e4'].map((id) => message(id))
    ])
    const pages = await readEveryPage(path, 2)

    expect(pages.map((page) => page.entries.map(idOf))).toEqual([
      ['e3', 'e4'],
      ['e1', 'e2'],
      ['e0']
    ])
  })

  it.each([
    [
      'replaced',
      (path: string) => {
        writeFileSync(`${path}.copy`, readFileSync(path))
        renameSync(`${path}.copy`, path)
      }
    ],
    ['shortened below the cursor', (path: string) => truncateSync(path, 40)],
    ['shortened above the cursor', (path: string) => truncateSync(path, statSync(path).size - 10)],
    [
      'rewritten in place to the same size',
      (path: string) => {
        writeFileSync(path, readFileSync(path, 'utf8').replace('"e1"', '"x1"'))
        utimesSync(path, 0, 2_000_000_000)
      }
    ]
  ])('refuses a cursor as stale once the file is %s', async (_change, change) => {
    const path = transcriptFile(Array.from({ length: 10 }, (_, index) => message(`e${index}`)))
    const cursor = (await readPage(path, 3)).nextCursor!
    change(path)

    await expect(readPage(path, 3, cursor)).rejects.toMatchObject({ code: 'agent_cursor_stale' })
  })

  it('refuses a cursor that was never valid for this agent', async () => {
    const path = transcriptFile(Array.from({ length: 10 }, (_, index) => message(`e${index}`)))
    const foreign = (await readPage(path, 3, undefined, 'another-agent')).nextCursor!
    const own = (await readPage(path, 3)).nextCursor!
    const payload = JSON.parse(Buffer.from(own.slice('oar1_'.length), 'base64url').toString())
    const futureVersion = `oar1_${Buffer.from(JSON.stringify({ ...payload, v: 2 })).toString('base64url')}`

    for (const cursor of [
      foreign,
      'oar1_not-json',
      'owr1_e30',
      futureVersion,
      `${own}${'A'.repeat(4_096)}`
    ]) {
      await expect(readPage(path, 3, cursor)).rejects.toMatchObject({
        code: 'agent_cursor_invalid'
      })
    }
    expect((await readPage(path, 3, own)).entries.map(idOf)).toEqual(['e4', 'e5', 'e6'])
  })

  it('pages across non-message stretches longer than the scan window', async () => {
    const path = transcriptFile([
      message('e0'),
      message('e1'),
      ...metadataStretch(9 * MIB),
      message('e2'),
      message('e3'),
      ...metadataStretch(9 * MIB)
    ])
    const pages = await readEveryPage(path, 5)

    expect(pages.map((page) => page.entries.map(idOf))).toEqual([
      [],
      ['e2', 'e3'],
      [],
      ['e0', 'e1']
    ])
  })

  it.each([
    ['ends the file with its newline', '\n'],
    ['is an unterminated trailing fragment', '']
  ])('passes over a record longer than the scan window that %s', async (_case, newline) => {
    const path = transcriptFile(['e0', 'e1', 'e2'].map((id) => message(id)))
    appendFileSync(path, `{"type":"assistant","text":"${'x'.repeat(20 * MIB)}"}${newline}`)
    const pages = await readEveryPage(path, 5)

    expect(pages.map((page) => page.entries.map(idOf))).toEqual([[], [], ['e0', 'e1', 'e2']])
  })

  it('keeps a message whose shown content was cut away as a shortened entry', async () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }
    const path = transcriptFile([
      message('e0'),
      JSON.stringify({
        type: 'user',
        uuid: 'images-then-text',
        message: {
          role: 'user',
          content: [...Array.from({ length: 6 }, () => image), { type: 'text', text: 'the prompt' }]
        }
      }),
      message('e1')
    ])

    expect((await readPage(path, 5)).entries).toEqual([
      { kind: 'message', role: 'assistant', text: 'e0' },
      { kind: 'message', role: 'user', text: '(content not shown)', shortened: true },
      { kind: 'message', role: 'assistant', text: 'e1' }
    ])
  })
})
