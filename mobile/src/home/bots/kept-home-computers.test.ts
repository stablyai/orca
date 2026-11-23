import { expect, it, vi } from 'vitest'
import { normalizeBotSidebarView } from '../../../../src/shared/bots/bot-sidebar-view'
import type { PhoneBot } from '../../bots/host-bots-operations'
import type { HomeComputerBots } from './home-bots-query'

const disk = vi.hoisted(() => new Map<string, string>())
// Computers whose device reads fail, as a file read that errors does.
const failing = vi.hoisted(() => new Map<string, number>())
vi.mock('../../device-store/device-store', () => ({
  processDeviceStore: () => ({
    read: async (hostId: string, table: string, keys: readonly string[]) => {
      const left = failing.get(hostId) ?? 0
      if (left > 0) {
        failing.set(hostId, left - 1)
        return { status: 'unavailable' }
      }
      return {
        status: 'ok',
        values: keys.map((key) => disk.get(`${hostId}|${table}|${key}`) ?? null)
      }
    },
    write: async (hostId: string, table: string, ops: { key: string; value: string | null }[]) => {
      for (const { key, value } of ops) {
        disk.set(`${hostId}|${table}|${key}`, value ?? '')
      }
      return { written: true }
    }
  })
}))

import {
  forgetKeptBots,
  KEEP_SERVER_BOTS_AFTER_MS,
  setKeptBotsRevoked
} from '../../bots/kept-server-bot-listings'
import {
  foldKeptHomeComputer,
  hydrateKeptHomeComputers,
  keptHomeComputers
} from './kept-home-computers'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the record keeps a bot as listed; only its id and name are read here.
const atlas = { id: 'atlas', name: 'Atlas', chatSessionId: null } as PhoneBot

function liveRead(hostId: string, bots: PhoneBot[]): HomeComputerBots {
  return {
    answers: [
      {
        key: `${hostId}\nlocal`,
        pairedHostId: hostId,
        executionHost: 'local',
        answer: {
          kind: 'bots',
          bots,
          hideBotCreated: false,
          view: normalizeBotSidebarView(undefined),
          enabled: true,
          takesCreate: true,
          takesTemplates: true,
          waits: {},
          needsYou: {}
        }
      }
    ],
    groups: [],
    epoch: '1:1',
    readAt: 1
  }
}

async function hydrated(hostId: string) {
  hydrateKeptHomeComputers([hostId])
  await vi.waitFor(() => expect(keptHomeComputers().get(hostId)?.hydration).toBe('done'))
  return keptHomeComputers().get(hostId)
}

const botNames = (hostId: string) =>
  keptHomeComputers()
    .get(hostId)
    ?.kept?.answers.flatMap((entry) =>
      entry.answer.kind === 'bots' ? entry.answer.bots.map((bot) => bot.name) : []
    )

it('keeps nothing from before a revocation, and keeps fresh reads once accepted again', async () => {
  await hydrated('studio')
  foldKeptHomeComputer('studio', liveRead('studio', [atlas]), {})
  expect(botNames('studio')).toEqual(['Atlas'])

  setKeptBotsRevoked('studio', true)
  expect((await hydrated('studio'))?.kept).toBeNull()
  foldKeptHomeComputer('studio', liveRead('studio', [atlas]), {})
  expect(botNames('studio')).toBeUndefined()

  setKeptBotsRevoked('studio', false)
  disk.clear()
  expect((await hydrated('studio'))?.kept).toBeNull()
  foldKeptHomeComputer('studio', liveRead('studio', []), {})
  expect(botNames('studio')).toEqual([])
})

it('drops a computer’s whole record when it is unpaired', async () => {
  await hydrated('air')
  foldKeptHomeComputer('air', liveRead('air', [atlas]), {})
  forgetKeptBots('air')
  expect(keptHomeComputers().has('air')).toBe(false)
})

it('never writes a read over a device copy it couldn’t read, and still shows the read', async () => {
  vi.useFakeTimers()
  try {
    failing.set('box', 1)
    disk.set('box|cache|bots.homeComputer.v1', 'the copy on disk')
    hydrateKeptHomeComputers(['box'])
    await vi.advanceTimersByTimeAsync(0)
    expect(keptHomeComputers().get('box')?.hydration).toBe('unreadable')
    foldKeptHomeComputer('box', liveRead('box', [atlas]), {})
    await vi.advanceTimersByTimeAsync(KEEP_SERVER_BOTS_AFTER_MS)
    expect(botNames('box')).toEqual(['Atlas'])
    expect(disk.get('box|cache|bots.homeComputer.v1')).toBe('the copy on disk')
  } finally {
    vi.useRealTimers()
  }
})
