import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { RuntimeProjectGroupController } from '../runtime/repositories/runtime-project-group-controller'
import type { Store } from '../persistence/loading-store/store'
import { BotController } from './bot-controller'
import { localBotHomeFilesystem } from './bot-home'

describe('designated Commander bot', () => {
  let bots: BotController
  let store: Store
  beforeEach(async () => {
    testState.dir = await mkdtemp(join(tmpdir(), 'orca-commander-bot-'))
    store = createStore()
    const groups = new RuntimeProjectGroupController({
      getStore: () => store,
      resolveRepo: () => {
        throw new Error('Unused in folder workspace')
      },
      notifyReposChanged: () => {},
      resolveFolderConnectionId: () => null,
      teardownFolderWorkspacePtys: async () => {},
      acquireFileWatcherRemoval: async () => ({ finish: async () => {} }),
      cleanupRemovedFolderWorkspaceState: () => {},
      emitWorktreeLifecycle: () => {}
    })
    bots = new BotController({
      getStore: () => store,
      notifyBotsWritten: () => {},
      createFolderWorkspace: async (input) =>
        (await groups.createFolderWorkspace(input)).folderWorkspace,
      deleteFolderWorkspace: async () => {},
      deleteBotAutomations: async () => {},
      botsRoot: () => join(testState.dir, 'bots'),
      filesystem: localBotHomeFilesystem
    })
  })
  afterEach(async () => {
    await closeTestStores()
    await rm(testState.dir, { recursive: true, force: true })
  })
  it('reopens the designated Commander chat after concurrent opens, a rename and a profile restart', async () => {
    const other = await bots.create({ name: 'Commander', agent: 'claude' })
    const [first, second] = await Promise.all([
      bots.ensureCommander(async () => 'codex'),
      bots.ensureCommander(async () => 'claude')
    ])
    expect(first.id).not.toBe(other.id)
    expect(first).toMatchObject({
      name: 'Commander 2',
      agent: 'codex',
      lookAround: { on: false },
      tidyUp: { on: false },
      chatSessionId: null
    })
    expect(second.id).toBe(first.id)
    await bots.update(first.id, { name: 'Fleet coordinator' })
    await bots.setChatSession(first.id, 'saved-conversation')
    store.flush()
    await closeTestStores()
    store = createStore()
    const reopened = await bots.ensureCommander(async () => {
      throw new Error('No provider currently available')
    })
    expect(reopened).toMatchObject({
      id: first.id,
      name: 'Fleet coordinator',
      chatSessionId: 'saved-conversation'
    })
    expect(store.getBots()).toHaveLength(2)
  })

  it('leaves the catalog untouched when Commander provider setup fails and can retry', async () => {
    await expect(
      bots.ensureCommander(async () => {
        throw new Error('Missing provider')
      })
    ).rejects.toThrow('Missing provider')
    expect(store.getBots()).toHaveLength(0)
    expect((await bots.ensureCommander(async () => 'codex')).name).toBe('Commander')
  })
})
