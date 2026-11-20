import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotItemAddInput, BotItemBotActor } from '../bot-items-input'
import { BotsDbWorkerClient } from './bots-db-worker-client'
import { closeBotsDbStores } from './bots-db-worker-entry'
import { inProcessBotsDbWorker } from './bots-db-worker.test-fixture'

const owner: BotItemBotActor = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' }

const input = (overrides: Partial<BotItemAddInput> = {}): BotItemAddInput => ({
  ownerBotId: 'bot-a',
  chatId: 'chat-home',
  source: { kind: 'home', title: 'Home Chat' },
  title: 'Share dialog',
  status: 'planned',
  links: [],
  ...overrides
})

let dir = ''
let client: BotsDbWorkerClient | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bots-db-worker-'))
})

afterEach(() => {
  client?.dispose()
  client = null
  closeBotsDbStores()
  rmSync(dir, { recursive: true, force: true })
})

async function codeOf(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'thrown'
  }
  return undefined
}

describe('bots DB worker client', () => {
  it('serializes concurrent writes and returns a refusal with its code', async () => {
    client = new BotsDbWorkerClient(inProcessBotsDbWorker().factory)
    const path = join(dir, 'bot-items.sqlite')
    const first = client.items(path)
    const second = client.items(path)

    const [a, b] = await Promise.all([
      first.add(input(), owner),
      second.add(input({ title: 'Share dialog v2' }), owner)
    ])

    expect(await first.get(a.uid)).toMatchObject({ number: 1, title: 'Share dialog' })
    expect(await first.get(b.uid)).toMatchObject({ number: 2, title: 'Share dialog v2' })
    expect(await codeOf(first.set(a.uid, { status: 'canceled' }, owner))).toBe('invalid_argument')
  })

  it('fails every call caught in a crash visibly, then restarts on the next call', async () => {
    const worker = inProcessBotsDbWorker()
    client = new BotsDbWorkerClient(worker.factory)
    const items = client.items(join(dir, 'bot-items.sqlite'))
    worker.controls.crashOn.add('latestEventId')

    const burst = [
      items.latestEventId('bot-a'),
      items.latestEventId('bot-a'),
      items.list({ botId: 'bot-a', statuses: [], limit: 10 })
    ]
    expect(await Promise.all(burst.map(codeOf))).toEqual([
      'items_unavailable',
      'items_unavailable',
      'items_unavailable'
    ])
    expect(worker.controls.spawned).toBe(1)

    worker.controls.crashOn.clear()
    expect(await items.latestEventId('bot-a')).toBe(0)
    expect(worker.controls.spawned).toBe(2)
  })
})
