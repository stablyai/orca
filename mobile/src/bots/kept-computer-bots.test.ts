import { afterEach, expect, it, vi } from 'vitest'
import { normalizeBotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import type { PhoneBot } from './host-bots-operations'

const disk = vi.hoisted(() => new Map<string, string>())
// While set, the store opens only once it resolves: a write waiting on it can outlive an unpair.
const opening = vi.hoisted((): { gate: Promise<void> | null } => ({ gate: null }))
vi.mock('../device-store/device-store', () => ({
  processDeviceStore: async () => {
    await opening.gate
    return store
  }
}))
const store = vi.hoisted(() => ({
  read: async (hostId: string, table: string, keys: readonly string[]) => ({
    status: 'ok',
    values: keys.map((key) => disk.get(`${hostId}|${table}|${key}`) ?? null)
  }),
  write: async (hostId: string, table: string, ops: { key: string; value: string | null }[]) => {
    for (const { key, value } of ops) {
      disk.set(`${hostId}|${table}|${key}`, value ?? '')
    }
    return { written: true }
  }
}))

import { keepComputerBots, readKeptComputerBots } from './kept-computer-bots'
import { forgetKeptBots, KEEP_SERVER_BOTS_AFTER_MS } from './kept-server-bot-listings'

afterEach(() => {
  vi.useRealTimers()
})

const ATLAS: PhoneBot = {
  id: 'atlas',
  name: 'Atlas',
  folderWorkspaceId: 'home-atlas',
  avatar: 'mascot:D1',
  paused: false,
  agent: 'claude',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null
}

it('keeps a paired computer’s answers across a restart, without its live counts', async () => {
  vi.useFakeTimers()
  keepComputerBots('studio', {
    answers: [
      {
        key: 'studio\nlocal',
        pairedHostId: 'studio',
        executionHost: 'local',
        readAt: 1,
        answer: {
          kind: 'bots',
          bots: [ATLAS],
          hideBotCreated: false,
          view: normalizeBotSidebarView(undefined),
          enabled: true,
          takesCreate: false,
          takesTemplates: true,
          waits: {},
          needsYou: { atlas: 3 }
        }
      },
      {
        key: 'studio\nruntime:old',
        pairedHostId: 'studio',
        executionHost: 'runtime:old',
        serverLabel: 'old-box',
        readAt: 1,
        answer: { kind: 'no-capability' }
      },
      {
        key: 'studio\nruntime:down',
        pairedHostId: 'studio',
        executionHost: 'runtime:down',
        readAt: 1,
        answer: { kind: 'unreachable' }
      }
    ],
    groups: [],
    lastActivity: { 'studio\nlocal\nbot:atlas': 42 }
  })
  await vi.advanceTimersByTimeAsync(KEEP_SERVER_BOTS_AFTER_MS)
  vi.useRealTimers()
  const kept = (await readKeptComputerBots(['studio', 'air'])).studio
  expect(await readKeptComputerBots(['air'])).toEqual({ air: null })
  expect(
    kept?.answers.map((entry) => [
      entry.key,
      entry.answer.kind,
      entry.answer.kind === 'bots' ? [entry.answer.takesCreate, entry.answer.needsYou] : null
    ])
  ).toEqual([
    ['studio\nlocal', 'bots', [false, {}]],
    ['studio\nruntime:old', 'no-capability', null]
  ])
  expect(kept?.lastActivity).toEqual({ 'studio\nlocal\nbot:atlas': 42 })
})

it('drops a write still waiting when the computer is unpaired', async () => {
  vi.useFakeTimers()
  keepComputerBots('air', { answers: [], groups: [], lastActivity: { row: 7 } })
  forgetKeptBots('air')
  await vi.advanceTimersByTimeAsync(KEEP_SERVER_BOTS_AFTER_MS)
  vi.useRealTimers()
  expect(await readKeptComputerBots(['air'])).toEqual({ air: null })
})

it('drops a write whose store opens after the computer is unpaired', async () => {
  vi.useFakeTimers()
  let open!: () => void
  opening.gate = new Promise((resolve) => {
    open = resolve
  })
  keepComputerBots('mini', { answers: [], groups: [], lastActivity: { row: 9 } })
  await vi.advanceTimersByTimeAsync(KEEP_SERVER_BOTS_AFTER_MS)
  forgetKeptBots('mini')
  open()
  opening.gate = null
  vi.useRealTimers()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect([...disk.keys()].some((key) => key.startsWith('mini|'))).toBe(false)
})
