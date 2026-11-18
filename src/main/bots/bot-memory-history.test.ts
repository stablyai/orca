import { join } from 'node:path'
import { HELD_BOT_RULES } from './bot-turn-rules.test-fixture'
import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { addBotMemoryFact, botMemoryChange } from '../../shared/bot-memory-lines'
import { createBotMemoryHistory } from './bot-memory-history'
import { createBotMemoryRecord } from './bot-memory-record'
import { createBotTurnContext } from './bot-turn-context'

const FOLDER = '/home/me/.orca/bots/scout'
const MEMORY = join(FOLDER, 'MEMORY.md')
const DAY = 24 * 60 * 60 * 1000

function bot(memory: string, start = Date.UTC(2026, 10, 6)) {
  const files = new Map([[MEMORY, memory]])
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    replaceText: async (path: string, expected: string, text: string) => {
      if (files.get(path) !== expected) {
        return false
      }
      files.set(path, text)
      return true
    },
    writeText: async (path: string, text: string, options?: { exclusive?: boolean }) => {
      if (options?.exclusive && files.has(path)) {
        return false
      }
      files.set(path, text)
      return true
    }
  }
  const stored = new Map<string, string>()
  let now = start
  const io = {
    read: (botId: string) => stored.get(botId) ?? null,
    write: (botId: string, text: string | null) =>
      void (text === null ? stored.delete(botId) : stored.set(botId, text)),
    bots: () => [...stored.keys()]
  }
  const history = createBotMemoryHistory(io, () => now)
  const record = createBotMemoryRecord(fs, history)
  const context = createBotTurnContext(fs, undefined, undefined, undefined, record)
  context.launched('chat', 'bot-1', FOLDER, { soul: 'Be brief.', memory }, true, HELD_BOT_RULES)
  const journal: AgentJournalRenderItem[] = []
  return {
    read: () => files.get(MEMORY) ?? '',
    write: (text: string) => files.set(MEMORY, text),
    remove: () => files.delete(MEMORY),
    /** The history file as stored. */
    stored: (botId = 'bot-1') => stored.get(botId),
    history,
    /** The same history as a restarted host opens it. */
    reopened: () => createBotMemoryHistory(io, () => now),
    reword: (from: string, to: string) =>
      record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
        botMemoryChange(file, file.replace(from, to))
      ),
    forget: (fact: string) => record.forget('bot-1', FOLDER, fact, { kind: 'owner' }),
    rows: () => record.history('bot-1'),
    record,
    later: (ms: number) => (now += ms),
    /** A chat turn that wrote MEMORY.md, ended; `memorySource` names who outside asked. */
    turnEnded: async (memorySource?: string) => {
      journal.push({
        itemId: `i${journal.length}`,
        revision: 1,
        sequence: journal.length + 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'remember' }],
          ...(memorySource ? { memorySource } : {})
        }
      })
      context.turnEnded?.('chat', `t${journal.length}`, async () => ({
        items: journal,
        openerIds: new Map()
      }))
      await record.after('bot-1', async () => undefined)
    },
    undo: (id: string) => record.undo('bot-1', FOLDER, id)
  }
}

const OLD = '# Memory\n- 2026-11-01 owner fact\n'

describe("a bot's memory history", () => {
  it("records a chat's addition and Orca's put-back, and undoes the addition for good", async () => {
    const { read, rows, turnEnded, undo, write } = bot(OLD)
    write('# Memory\n- 2026-11-06 releases go out Tuesdays\n- 2026-11-01 owner fact\n')
    await turnEnded()
    write('# Memory\n- 2026-11-06 releases go out Tuesdays\n')
    await turnEnded()

    const [kept, added] = rows()
    expect(kept.by).toEqual({ kind: 'kept', sessionId: 'chat' })
    expect(kept.change.added.map(({ line }) => line)).toEqual(['- 2026-11-01 owner fact'])
    expect(added.by).toEqual({ kind: 'chat', sessionId: 'chat', source: null })
    expect(added.change.added.map(({ line }) => line)).toEqual([
      '- 2026-11-06 releases go out Tuesdays'
    ])

    expect(await undo(added.id)).toBe(true)
    expect(read()).toBe(OLD)
    await turnEnded()
    expect(read()).toBe(OLD)
    expect(rows()[0].by).toEqual({ kind: 'undo', of: added.id })
  })

  it("undoes the owner's rewording, putting the old words back where they were", async () => {
    const { read, record, rows, undo } = bot(`${OLD}- 2026-11-02 deploys at noon\n`)
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, file.replace('deploys at noon', 'deploys at 1pm'))
    )
    expect(rows()[0].change.removed.map(({ line }) => line)).toEqual([
      '- 2026-11-02 deploys at noon'
    ])

    expect(await undo(rows()[0].id)).toBe(true)
    expect(read()).toBe(`${OLD}- 2026-11-02 deploys at noon\n`)
  })

  it('keeps a secret-looking change redacted and refuses to undo it', async () => {
    const { record, rows, undo } = bot(OLD)
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(
        file,
        addBotMemoryFact(file, 'deploy key ghp_abcdefghijklmnopqrstuvwxyz0123', '2026-11-06')
      )
    )
    const [row] = rows()
    expect(row.undoable).toBe(false)
    expect(JSON.stringify(row)).not.toContain('ghp_')
    await expect(undo(row.id)).rejects.toThrow('can’t be undone')
  })

  it('keeps 90 days of changes', async () => {
    const { later, record, rows } = bot(OLD)
    await record.forget('bot-1', FOLDER, 'owner fact', { kind: 'owner' })
    later(90 * DAY)
    expect(rows()).toHaveLength(1)
    later(1)
    expect(rows()).toEqual([])
  })

  it('leaves an edit alone once its new words were changed again or forgotten', async () => {
    const reworded = bot('# Memory\n- releases on Monday\n')
    await reworded.reword('Monday', 'Tuesday')
    await reworded.reword('Tuesday', 'Wednesday')
    expect(await reworded.undo(reworded.rows()[1].id)).toBe(false)
    expect(reworded.read()).toBe('# Memory\n- releases on Wednesday\n')

    const forgotten = bot('# Memory\n- releases on Monday\n')
    await forgotten.reword('Monday', 'Tuesday')
    await forgotten.forget('releases on Tuesday')
    expect(await forgotten.undo(forgotten.rows()[1].id)).toBe(false)
    expect(forgotten.read()).toBe('# Memory\n')
  })

  it('keeps no password, key or token in a row or its source, and such rows stay as they are', async () => {
    const { record, rows, stored, turnEnded, write } = bot(OLD)
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, addBotMemoryFact(file, 'staging password=hunter2', '2026-11-06'))
    )
    write(`${OLD}- 2026-11-06 deploys run nightly\n`)
    await turnEnded('Automation deploy ghp_abcdefghijklmnopqrstuvwxyz0123')

    expect(stored()).not.toMatch(/hunter2|ghp_/)
    expect(rows()[1].undoable).toBe(false)
  })

  it('records a Forget of a fact a chat had just written over, and can undo it', async () => {
    const { forget, read, rows, turnEnded, undo, write } = bot(OLD)
    write('# Memory\n')
    expect(await forget('owner fact')).toBe(true)
    await turnEnded()
    expect(read()).toBe('# Memory\n')

    expect(rows()[0].change.removed.map(({ line }) => line)).toEqual(['- 2026-11-01 owner fact'])
    expect(await undo(rows()[0].id)).toBe(true)
    expect(read()).toBe(OLD)
  })

  it("deletes rows past 90 days from disk, and every bot's on a host's first use", async () => {
    const { forget, history, later, reopened, stored } = bot(OLD)
    await forget('owner fact')
    history.append('bot-2', { kind: 'owner' }, botMemoryChange('', '- another fact\n'))
    later(91 * DAY)

    expect(history.list('bot-1')).toEqual([])
    expect(stored('bot-1')).toBeUndefined()
    reopened().list('bot-3')
    expect(stored('bot-2')).toBeUndefined()
  })

  it('creates MEMORY.md for a change when the file is missing', async () => {
    const { read, record, remove, rows } = bot(OLD)
    remove()
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, addBotMemoryFact(file, 'a new fact', '2026-11-06'))
    )
    expect(read()).toBe('- 2026-11-06 a new fact\n')
    expect(rows()[0].change.added.map(({ line }) => line)).toEqual(['- 2026-11-06 a new fact'])
  })

  it('counts changes queued ahead of an Undo as later ones', async () => {
    const { forget, read, record, rows, undo } = bot(OLD)
    await forget('owner fact')
    const first = rows()[0].id
    const adding = record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, addBotMemoryFact(file, 'owner fact', '2026-11-06'))
    )
    const forgetting = forget('owner fact')
    const undoing = undo(first)
    await Promise.all([adding, forgetting])

    expect(await undoing).toBe(false)
    expect(read()).toBe('# Memory\n')
  })
})
