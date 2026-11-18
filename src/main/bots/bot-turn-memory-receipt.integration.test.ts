import { join } from 'node:path'
import { HELD_BOT_RULES } from './bot-turn-rules.test-fixture'
import { expect, it } from 'vitest'
import type {
  AgentJournalPlainStatusItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { createBotMemoryRecord } from './bot-memory-record'
import { createBotTurnContext } from './bot-turn-context'

const FOLDER = '/bot'
const MEMORY = join(FOLDER, 'MEMORY.md')

function setup() {
  const files = new Map([[MEMORY, '- old fact\n']])
  let duringRead: (() => Promise<unknown>) | null = null
  const fs = {
    readText: async (path: string) => {
      const text = files.get(path) ?? null
      if (path === MEMORY && duringRead) {
        const run = duringRead
        duringRead = null
        await run()
      }
      return text
    },
    listNames: async () =>
      [...files.keys()]
        .filter((path) => path !== MEMORY)
        .map((path) => path.split(/[\\/]/).at(-1)!),
    replaceText: async (path: string, expected: string, text: string) => {
      if (files.get(path) !== expected) {
        return false
      }
      files.set(path, text)
      return true
    },
    writeText: async (path: string, text: string) => {
      files.set(path, text)
      return true
    }
  }
  const record = createBotMemoryRecord(fs)
  const context = createBotTurnContext(fs, undefined, undefined, undefined, record)
  context.launched('s1', 'b1', FOLDER, { soul: '', memory: '- old fact\n' }, true, HELD_BOT_RULES)
  const message = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'remember' }]
  } as const
  const rows: AgentJournalRenderItem[] = [
    {
      itemId: 'tool',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'Bash',
        input: { command: 'write memory' },
        state: 'completed'
      }
    }
  ]
  const notes: AgentJournalPlainStatusItem[] = []
  return {
    files,
    record,
    notes,
    onRead: (run: () => Promise<unknown>) => {
      duringRead = run
    },
    start: async () => {
      await context.plan('s1', { ...message, blocks: [...message.blocks] })
    },
    end: async () => {
      const latest = rows[0]
      if (latest) {
        rows.push({ ...latest, itemId: `tool-${rows.length}`, sequence: rows.length + 1 })
      }
      context.turnEnded?.(
        's1',
        't1',
        async () => ({ items: rows, openerIds: new Map() }),
        async (_id, body) => {
          notes.push(body)
        }
      )
      await record.after('b1', async () => undefined)
    }
  }
}

it('reports a committed Forget even though Forget already updated the shared record', async () => {
  const b = setup()
  await b.start()
  await b.record.forget('b1', FOLDER, 'old fact', { kind: 'bot', sessionId: 's1' })
  await b.end()
  await b.end()
  expect(b.notes.map((x) => x.text)).toEqual(['Memory updated · 1 removed'])
})

it('reports a durable topic-only write, never an unchanged edit attempt', async () => {
  const b = setup()
  await b.start()
  await b.end()
  expect(b.notes).toEqual([])
  await b.start()
  b.files.set(join(FOLDER, 'memory', 'client.md'), '# Client\nprivate text')
  await b.end()
  expect(b.notes.map((x) => x.text)).toEqual(['Memory updated · 1 note changed'])
})

it('does not attribute an owner save to this turn', async () => {
  const b = setup()
  await b.start()
  await b.record.change('b1', FOLDER, { kind: 'owner' }, () => ({
    added: [{ line: '- owner saved', after: null }],
    removed: []
  }))
  await b.end()
  expect(b.notes).toEqual([])
})

it('does not claim an owner write racing the turn-start snapshot', async () => {
  const b = setup()
  b.onRead(() =>
    b.record.change('b1', FOLDER, { kind: 'owner' }, () => ({
      added: [{ line: '- saved by the owner', after: null }],
      removed: []
    }))
  )
  await b.start()
  await b.end()
  expect(b.notes).toEqual([])
})
