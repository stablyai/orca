import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../../persistence-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => []),
  sshConfigHostsToTargets: vi.fn(() => [])
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

describe('bot order persistence across Store reloads', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'bot-order-store-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('clears botsNewerAgents and botOrder when the last newer-agent bot is removed, and applies saved botOrder before dropping on load', async () => {
    let store = createStore()
    store.saveBot(makeTestBot({ id: 'first-bot', name: 'First', folderWorkspaceId: 'first-home' }))
    store.saveBot(
      makeTestBot({
        id: 'cursor-bot',
        name: 'Cursor',
        folderWorkspaceId: 'cursor-home',
        agent: 'cursor'
      })
    )
    store.saveBot(makeTestBot({ id: 'last-bot', name: 'Last', folderWorkspaceId: 'last-home' }))
    store.flush()
    await closeTestStores()

    const persisted = readPersistedState()
    expect(persisted.bots?.map((bot) => bot.id)).toEqual(['first-bot', 'last-bot'])
    expect(persisted.botsNewerAgents?.map((bot) => bot.id)).toEqual(['cursor-bot'])

    store = createStore()
    expect(store.getBots().map((bot) => bot.id)).toEqual(['first-bot', 'cursor-bot', 'last-bot'])
    expect(store.removeBot({ id: 'cursor-bot', hostId: 'local' })).toBe(true)
    store.flush()
    await closeTestStores()

    const cleaned = readPersistedState()
    expect(cleaned).not.toHaveProperty('botsNewerAgents')
    expect(cleaned).not.toHaveProperty('botOrder')
    expect(
      createStore()
        .getBots()
        .map((bot) => bot.id)
    ).toEqual(['first-bot', 'last-bot'])
    await closeTestStores()

    writeDataFile({
      ...cleaned,
      botsNewerAgents: [],
      botOrder: ['last-bot', 'first-bot']
    })
    store = createStore()
    expect(store.getBots().map((bot) => bot.id)).toEqual(['last-bot', 'first-bot'])
  })
})
