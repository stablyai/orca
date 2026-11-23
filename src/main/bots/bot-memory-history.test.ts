import { join } from 'node:path'
import { HELD_BOT_RULES } from './bot-turn-rules.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { addBotMemoryFact, botMemoryChange } from '../../shared/bot-memory-lines'
import { createBotMemoryHistory } from './bot-memory-history'
import type { BotMemoryHistoryRow } from '../../shared/bots/bot-memory-history'
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
  // A deliberately slow disk, so every history read and write lands a few turns later.
  const slow = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve()
    }
  }
  const io = {
    read: async (botId: string) => {
      const text = stored.get(botId) ?? null
      await slow()
      return text
    },
    write: async (botId: string, text: string | null) => {
      await slow()
      void (text === null ? stored.delete(botId) : stored.set(botId, text))
    },
    bots: async () => [...stored.keys()]
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
    /** The history file as stored, once queued writes land. */
    stored: async (botId = 'bot-1') => {
      await history.settled()
      return stored.get(botId)
    },
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

    const [kept, added] = await rows()
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
    expect((await rows())[0].by).toEqual({ kind: 'undo', of: added.id })
  })

  it("undoes the owner's rewording, putting the old words back where they were", async () => {
    const { read, record, rows, undo } = bot(`${OLD}- 2026-11-02 deploys at noon\n`)
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, file.replace('deploys at noon', 'deploys at 1pm'))
    )
    expect((await rows())[0].change.removed.map(({ line }) => line)).toEqual([
      '- 2026-11-02 deploys at noon'
    ])

    expect(await undo((await rows())[0].id)).toBe(true)
    expect(read()).toBe(`${OLD}- 2026-11-02 deploys at noon\n`)
  })

  it('keeps a secret-looking change redacted and refuses to undo it', async () => {
    const { record, rows, stored, turnEnded, undo, write } = bot(OLD)
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, addBotMemoryFact(file, 'staging password=hunter2', '2026-11-06'))
    )
    const [row] = await rows()
    expect(row.undoable).toBe(false)
    await expect(undo(row.id)).rejects.toThrow('can’t be undone')
    write(`${OLD}- 2026-11-06 deploys run nightly\n`)
    await turnEnded('Automation deploy ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(await stored()).not.toMatch(/hunter2|ghp_/)
  })

  it('leaves an edit alone once its new words were changed again or forgotten', async () => {
    const reworded = bot('# Memory\n- releases on Monday\n')
    await reworded.reword('Monday', 'Tuesday')
    await reworded.reword('Tuesday', 'Wednesday')
    expect(await reworded.undo((await reworded.rows())[1].id)).toBe(false)
    expect(reworded.read()).toBe('# Memory\n- releases on Wednesday\n')

    const forgotten = bot('# Memory\n- releases on Monday\n')
    await forgotten.reword('Monday', 'Tuesday')
    await forgotten.forget('releases on Tuesday')
    expect(await forgotten.undo((await forgotten.rows())[1].id)).toBe(false)
    expect(forgotten.read()).toBe('# Memory\n')
  })

  it('records a Forget of a fact a chat had just written over, and can undo it', async () => {
    const { forget, read, rows, turnEnded, undo, write } = bot(OLD)
    write('# Memory\n')
    expect(await forget('owner fact')).toBe(true)
    await turnEnded()
    expect(read()).toBe('# Memory\n')

    expect((await rows())[0].change.removed.map(({ line }) => line)).toEqual([
      '- 2026-11-01 owner fact'
    ])
    expect(await undo((await rows())[0].id)).toBe(true)
    expect(read()).toBe(OLD)
  })

  it("deletes rows past 90 days from disk, and every bot's on a host's first use", async () => {
    const { forget, history, later, reopened, stored } = bot(OLD)
    await forget('owner fact')
    await history.append('bot-2', { kind: 'owner' }, botMemoryChange('', '- another fact\n'))
    later(90 * DAY)
    expect(await history.list('bot-1')).toHaveLength(1)
    later(1)
    expect(await history.list('bot-1')).toEqual([])
    expect(await stored('bot-1')).toBeUndefined()
    const restarted = reopened()
    await restarted.list('bot-3')
    await restarted.settled()
    expect(await stored('bot-2')).toBeUndefined()
  })

  it('returns the newest edits in order after a stalled write, including after restart', async () => {
    const stored = new Map<string, string>()
    const stalled = Promise.withResolvers<void>()
    const writeStarted = Promise.withResolvers<void>()
    const io = {
      read: async (botId: string) => stored.get(botId) ?? null,
      write: async (botId: string, text: string | null) => {
        writeStarted.resolve()
        await stalled.promise
        void (text === null ? stored.delete(botId) : stored.set(botId, text))
      },
      bots: async () => []
    }
    const history = createBotMemoryHistory(io)
    const edit = (fact: string) =>
      history.append('bot-1', { kind: 'owner' }, botMemoryChange('', `- ${fact}\n`))
    const first = edit('first')
    await writeStarted.promise
    const second = edit('second')
    const earlierRead = history.list('bot-1')
    const third = edit('third')
    const latestRead = history.list('bot-1')
    stalled.resolve()
    await Promise.all([first, second, earlierRead, third])

    const lines = (rows: Awaited<typeof latestRead>) => rows.map((row) => row.change.added[0]?.line)
    expect(lines(await latestRead)).toEqual(['- third', '- second', '- first'])
    expect(lines(await createBotMemoryHistory(io).list('bot-1'))).toEqual([
      '- third',
      '- second',
      '- first'
    ])
  })

  it('keeps an edit made right after a bot is removed, and shows nothing of it to a read after', async () => {
    const stored = new Map<string, string>()
    let release = (): void => {}
    const stalled = new Promise<void>((resolve) => (release = resolve))
    let writes = 0
    const io = {
      read: async (botId: string) => stored.get(botId) ?? null,
      write: async (botId: string, text: string | null) => {
        writes += 1
        await stalled
        void (text === null ? stored.delete(botId) : stored.set(botId, text))
      },
      bots: async () => []
    }
    const history = createBotMemoryHistory(io)
    const edit = (fact: string) =>
      history.append('bot-1', { kind: 'owner' }, botMemoryChange('', `- ${fact}\n`))
    const first = edit('before')
    await vi.waitFor(() => expect(writes).toBe(1))
    const queued = [edit('queued'), history.removed('bot-1')]
    const after = edit('after')
    const read = history.list('bot-1')
    release()
    await Promise.all([first, ...queued, after])

    expect((await read).map((row) => row.change.added[0]?.line)).toEqual(['- after'])
  })

  it('says a row was undone from memory once the bot was read, whatever the disk is doing', async () => {
    const stored = new Map<string, string>()
    let stall = false
    const never = new Promise<never>(() => {})
    const io = {
      read: async (botId: string) => (stall ? await never : (stored.get(botId) ?? null)),
      write: async (botId: string, text: string | null) =>
        void (text === null ? stored.delete(botId) : stored.set(botId, text)),
      bots: async () => []
    }
    const history = createBotMemoryHistory(io)
    await history.append('bot-1', { kind: 'owner' }, botMemoryChange('', '- tidied\n'))
    expect(history.undoneKnown('bot-1', 'any')).toBeUndefined()
    const [tidied] = await history.list('bot-1')
    stall = true
    void history.append('bot-1', { kind: 'undo', of: tidied.id }, botMemoryChange('- tidied\n', ''))

    expect(history.undoneKnown('bot-1', tidied.id)).toBe(true)
    expect(history.undoneKnown('bot-1', 'another-row')).toBe(false)
  })

  it('tells only the latest of everyone asking while its disk is stalled', async () => {
    let release = (): void => {}
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const io = {
      read: async () => {
        await stalled
        return null
      },
      write: async () => {},
      bots: async () => []
    }
    const history = createBotMemoryHistory(io)
    const told: number[] = []
    history.whenUndoneKnown('bot-1', () => told.push(1))
    history.whenUndoneKnown('bot-1', () => told.push(2))
    release()
    await vi.waitFor(() => expect(told).toEqual([2]))

    expect(history.undoneKnown('bot-1', 'any')).toBe(false)
  })

  it('says a row was undone once old rows could not be pruned for a moment', async () => {
    const now = Date.UTC(2026, 10, 6)
    const row = (id: string, at: number, by: BotMemoryHistoryRow['by']) => ({
      id,
      at,
      by,
      change: { added: [], removed: [] },
      undoable: true
    })
    let text: string | null = JSON.stringify([
      row('undo', now, { kind: 'undo', of: 'tidied' }),
      row('tidied', now, { kind: 'owner' }),
      row('expired', now - 91 * DAY, { kind: 'owner' })
    ])
    let writeFails = true
    const io = {
      read: async () => text,
      write: async (_botId: string, next: string | null) => {
        if (writeFails) {
          throw new Error('EBUSY')
        }
        text = next
      },
      bots: async () => []
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const history = createBotMemoryHistory(io, () => now)
    const told = vi.fn()
    history.whenUndoneKnown('bot-1', told)
    await history.settled()
    writeFails = false
    history.whenUndoneKnown('bot-1', told)
    await history.settled()

    expect(history.undoneKnown('bot-1', 'tidied')).toBe(true)
  })

  it('forgets what was undone when the bot is removed', async () => {
    const { history, forget } = bot(OLD)
    await forget('owner fact')
    const [forgot] = await history.list('bot-1')
    await history.append('bot-1', { kind: 'undo', of: forgot.id }, botMemoryChange('', '- x\n'))
    expect(history.undoneKnown('bot-1', forgot.id)).toBe(true)

    await history.removed('bot-1')
    expect(history.undoneKnown('bot-1', forgot.id)).toBeUndefined()
  })

  it('creates MEMORY.md for a change when the file is missing', async () => {
    const { read, record, remove, rows } = bot(OLD)
    remove()
    await record.change('bot-1', FOLDER, { kind: 'owner' }, (file) =>
      botMemoryChange(file, addBotMemoryFact(file, 'a new fact', '2026-11-06'))
    )
    expect(read()).toBe('- 2026-11-06 a new fact\n')
    expect((await rows())[0].change.added.map(({ line }) => line)).toEqual([
      '- 2026-11-06 a new fact'
    ])
  })

  it('counts changes queued ahead of an Undo as later ones', async () => {
    const { forget, read, record, rows, undo } = bot(OLD)
    await forget('owner fact')
    const first = (await rows())[0].id
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
