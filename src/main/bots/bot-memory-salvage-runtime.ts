// Salvage on this host: the offer's reads and writes on the real Items, MEMORY.md and journal, one
// pass at a time per bot. A pass runs after a pilot bot's Tidy-up, and when its open proposal's
// item changes (the owner may have answered).
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { botMemoryLineKey } from '../../shared/bot-memory-lines'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import { botHomeFolder, localBotHomeFilesystem } from './bot-home'
import type { BotItemsHost } from './bot-items-runtime'
import type { BotMemoryRecord } from './bot-memory-record'
import { salvageOffer, type SalvageOfferDeps } from './bot-memory-salvage-offer'
import { hostSalvageStore } from './bot-memory-salvage-store'

const WHY = 'salvage'
const EVENTS_PAGE = 50

/** The owner's first name as this computer knows it, for "Dana picked"; none when unknown. */
let ownerNamesRead: Promise<string[]> | null = null
function hostOwnerNames(): Promise<string[]> {
  ownerNamesRead ??= new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve([])
      return
    }
    execFile('id', ['-F'], { timeout: 5_000 }, (error, stdout) => {
      const first = error ? '' : (String(stdout).trim().split(/\s+/)[0] ?? '')
      resolve(first.length >= 2 ? [first] : [])
    })
  })
  return ownerNamesRead
}

export function runtimeSalvage(runtime: {
  bots: { list: () => readonly Bot[]; memory: Pick<BotMemoryRecord, 'change'> }
  botItems: Pick<BotItemsHost, 'store'>
}): { pass: (botId: string) => Promise<void>; noticed: (scope: BotChangeScope) => void } {
  const store = hostSalvageStore()
  const items = () => runtime.botItems.store()
  const bot = (botId: string) => runtime.bots.list().find(({ id }) => id === botId) ?? null
  const deps: SalvageOfferDeps = {
    store,
    items: {
      ask: async (botId, { title, description, ask }) => {
        const chatId = bot(botId)?.chatSessionId
        if (!chatId) {
          return null
        }
        const input = { ownerBotId: botId, chatId, source: { kind: 'home' as const, title: null } }
        const { uid } = await items().orcaAsk({ ...input, title, description }, ask, WHY)
        const made = await items().get(uid)
        return made && made.questionEvent !== null
          ? { uid, number: made.number, question: made.questionEvent }
          : null
      },
      reask: async (uid, ask) => {
        await items().orcaSet(uid, { status: 'needs_you', ask }, WHY)
        const item = await items().get(uid)
        if (item?.questionEvent == null) {
          throw new Error('salvage: the item asked again has no question')
        }
        return item.questionEvent
      },
      close: async (uid, to, note) => {
        await items().orcaSet(
          uid,
          to === 'canceled' ? { status: to, reason: note } : { status: to, note },
          WHY
        )
      },
      status: async (uid) => (await items().get(uid))?.status ?? null,
      ownerComments: async (uid, after) => {
        const found: { id: number; text: string }[] = []
        for (let from = after; ;) {
          const page = await items().events(uid, from, EVENTS_PAGE)
          for (const event of page) {
            if (event.kind === 'commented' && event.actor.kind === 'owner') {
              found.push({ id: event.id, text: String(event.data.text ?? '') })
            }
          }
          if (page.length < EVENTS_PAGE) {
            return found
          }
          from = page.at(-1)!.id
        }
      }
    },
    journal: async (botId) => {
      const months = new Map<string, string[]>()
      const found = bot(botId)
      if (!found) {
        return months
      }
      const folder = join(botHomeFolder(found), 'memory', 'journal')
      for (const name of await localBotHomeFilesystem.listNames(folder)) {
        const month = /^(\d{4}-\d{2})\.md$/.exec(name)?.[1]
        const text = month ? await localBotHomeFilesystem.readText(join(folder, name)) : null
        if (month && text !== null) {
          months.set(month, text.split(/\r?\n/))
        }
      }
      return months
    },
    restore: async (botId, line, origin) => {
      const found = bot(botId)
      if (!found) {
        throw new Error('salvage: the bot is gone')
      }
      const key = botMemoryLineKey({ line, after: null })
      let present = false
      await runtime.bots.memory.change(
        botId,
        botHomeFolder(found),
        { kind: 'owner', restored: origin },
        (file) => {
          const lines = file.split(/\r?\n/)
          present = lines.some((raw) => botMemoryLineKey({ line: raw, after: null }) === key)
          // At the end of the file, after its last line.
          const after = lines.findLast((raw) => raw.trim() !== '') ?? null
          return present ? { added: [], removed: [] } : { added: [{ line, after }], removed: [] }
        }
      )
      return present ? 'kept-already-present' : 'kept'
    },
    ownerNames: hostOwnerNames,
    now: Date.now
  }
  const running = new Map<string, Promise<void>>()
  const pass = (botId: string): Promise<void> => {
    const next = (running.get(botId) ?? Promise.resolve())
      .then(() => salvageOffer(botId, deps))
      .catch((error) => console.warn('[bots] salvage pass failed', error))
    running.set(botId, next)
    void next.then(() => running.get(botId) === next && running.delete(botId))
    return next
  }
  return {
    pass,
    // Item changes of a bot with an open proposal: its owner may have answered.
    noticed: (scope) => {
      for (const botId of scope.botIds ?? []) {
        void store.get(botId).then((salvage) => salvage.proposal && pass(botId))
      }
    }
  }
}
