import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BotItemLinkView } from '../../shared/bots/bot-items'
import { makeTestBot } from './bot.test-fixture'
import { appendJournalLines, journalLines } from './bot-memory-journal'
import { createBotMemoryJournal, type JournalCandidate } from './bot-memory-journal-runtime'

const CLOSED = new Date(2026, 10, 21, 15, 0).getTime()
const pr = (number: number, state: 'open' | 'merged' | 'closed'): BotItemLinkView => ({
  kind: 'pr',
  ref: `pr:o/r#${number}`,
  pr: {
    shown: true,
    ref: `pr:o/r#${number}`,
    number,
    url: 'https://example.test',
    state,
    checks: null,
    review: null,
    checkedAt: null
  }
})
const item = (links: BotItemLinkView[], title = 'Sidebar "search" [fix]'): JournalCandidate => ({
  number: 1006,
  title,
  status: 'done',
  links,
  closedAt: CLOSED,
  chatId: 'c1'
})

function memoryFs() {
  const files = new Map<string, string>()
  return {
    files,
    readText: async (path: string) => files.get(path) ?? null,
    writeText: async (path: string, text: string, opts?: { exclusive?: boolean }) =>
      !(opts?.exclusive && files.has(path)) && (files.set(path, text), true),
    replaceText: async (path: string, expected: string, text: string) =>
      files.get(path) === expected && (files.set(path, text), true),
    makeDirectory: async () => {}
  }
}

describe("a bot's journal lines", () => {
  it('names each PR with its state, starting with the date so journal files sort together', () => {
    expect(journalLines(item([pr(4417, 'merged'), pr(4420, 'open')]))).toEqual([
      '- 2026-11-21 | item #1006 | PR #4417 merged | Sidebar search fix',
      '- 2026-11-21 | item #1006 | PR #4420 open at close | Sidebar search fix'
    ])
    expect(journalLines(item([]))).toEqual([
      '- 2026-11-21 | item #1006 | done | Sidebar search fix'
    ])
  })

  it('reads at most five PRs and names the rest without a state', () => {
    const lines = journalLines(item([1, 2, 3, 4, 5, 6].map((n) => pr(n, 'merged'))))
    expect(lines.at(-1)).toBe(
      '- 2026-11-21 | item #1006 | PR #6 state not read | Sidebar search fix'
    )
    const unread: BotItemLinkView = { kind: 'pr', ref: 'pr:o/r#7', pr: null }
    expect(journalLines(item([unread]))).toEqual([
      '- 2026-11-21 | item #1006 | PR #7 state unknown | Sidebar search fix'
    ])
  })

  it("adds each line once to its month's file", async () => {
    const fs = memoryFs()
    const line = '- 2026-11-21 | item #1006 | done | Fix'
    expect(
      await appendJournalLines(fs, '/home', [line, '- 2026-12-01 | item #7 | done | Ship'])
    ).toBe(2)
    expect(await appendJournalLines(fs, '/home', [line])).toBe(0)
    // A close is journaled once: the same close seen again with a newer PR state adds nothing.
    const later = '- 2026-11-21 | item #1007 | PR #4417 merged | Fix'
    const earlier = '- 2026-11-21 | item #1007 | PR #4417 open at close | Fix'
    expect(await appendJournalLines(fs, '/home', [earlier])).toBe(1)
    expect(await appendJournalLines(fs, '/home', [later])).toBe(0)
    expect(fs.files.get(join('/home', 'memory', 'journal', '2026-11.md'))).toBe(
      `# Journal 2026-11\n${line}\n${earlier}\n`
    )
  })
})

describe("the host's journal pass", () => {
  it('writes a close once even when the cache learns its PR between passes', async () => {
    const fs = memoryFs()
    const unread: BotItemLinkView = { kind: 'pr', ref: 'pr:o/r#7', pr: null }
    let links: BotItemLinkView[] = [unread]
    const journal = createBotMemoryJournal({
      bots: () => [makeTestBot({ id: 'b1' })],
      closedItems: async () => [item(links)],
      ownerChat: () => true,
      folder: () => '/home',
      serialize: async (_botId, step) => step(),
      fs,
      now: () => CLOSED + 1_000
    })
    journal.itemsChanged(['b1'])
    await journal.settled()
    links = [pr(7, 'merged')]
    journal.itemsChanged(['b1'])
    await journal.settled()
    expect(fs.files.get(join('/home', 'memory', 'journal', '2026-11.md'))).toBe(
      '# Journal 2026-11\n- 2026-11-21 | item #1006 | PR #7 state unknown | Sidebar search fix\n'
    )
  })

  it('tries lines again on the next pass when the file kept changing', async () => {
    const fs = memoryFs()
    let busy = true
    const replace = fs.replaceText
    const create = fs.writeText
    fs.writeText = async (...args) => !busy && create(...args)
    fs.replaceText = async (...args) => !busy && replace(...args)
    const journal = createBotMemoryJournal({
      bots: () => [makeTestBot({ id: 'b1' })],
      closedItems: async () => [item([])],
      ownerChat: () => true,
      folder: () => '/home',
      serialize: async (_botId, step) => step(),
      fs,
      now: () => CLOSED + 1_000
    })
    journal.itemsChanged(['b1'])
    await journal.settled()
    busy = false
    journal.itemsChanged(['b1'])
    await journal.settled()
    expect(fs.files.get(join('/home', 'memory', 'journal', '2026-11.md'))).toBe(
      '# Journal 2026-11\n- 2026-11-21 | item #1006 | done | Sidebar search fix\n'
    )
  })

  it("journals only the owner's closed items, once, however often items change", async () => {
    const fs = memoryFs()
    const bot = makeTestBot({ id: 'b1' })
    const journal = createBotMemoryJournal({
      bots: () => [bot],
      closedItems: async () => [
        item([pr(4417, 'merged')]),
        { ...item([], 'A teammate errand'), number: 1007, chatId: 'teammate' }
      ],
      ownerChat: (chatId) => chatId !== 'teammate',
      folder: () => '/home',
      serialize: async (_botId, step) => step(),
      fs,
      now: () => CLOSED + 1_000
    })
    journal.itemsChanged(['b1'])
    journal.itemsChanged(['b1'])
    await journal.settled()
    expect(fs.files.get(join('/home', 'memory', 'journal', '2026-11.md'))).toBe(
      '# Journal 2026-11\n- 2026-11-21 | item #1006 | PR #4417 merged | Sidebar search fix\n'
    )
  })
})
