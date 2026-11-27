import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import * as writeScheduling from '../loading-store/profile-writing/write-scheduling'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedState,
  workspaceRepos,
  writePersistedStateJson
} from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('../loading-store/store')
afterEach(async () => {
  vi.restoreAllMocks()
  await closeTestStores()
})

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`
const WORKTREE = 'repo::/a|b'

function seed(ui: Record<string, unknown>): string {
  const dataFile = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'orca-read-mark-copy-'))),
    'state.json'
  )
  const state = getDefaultPersistedState(tmpdir())
  state.repos = workspaceRepos(WORKTREE)
  state.ui = { ...state.ui, ...ui }
  state.workspaceSession = {
    ...state.workspaceSession,
    unifiedTabs: {
      [WORKTREE]: [
        {
          id: 'agent-chat-tab-v1-abc',
          entityId: 'sess-2',
          groupId: 'g',
          worktreeId: WORKTREE,
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  }
  writePersistedStateJson(dataFile, JSON.stringify(state))
  return dataFile
}

function load(ui: Record<string, unknown>) {
  return createSqliteTestStore(Store, { dataFile: seed(ui) }).getUI()
}

it('copies a reopened chat tab’s saved acknowledgement with a selective UI save', async () => {
  const dataFile = seed({
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 100 },
    _chatReadMarksCopiedToConversationKeys: true
  })
  createSqliteTestStore(Store, { dataFile }).flushOrThrow()
  await closeTestStores()
  const normalized = readPersistedState(dataFile)
  delete normalized.ui._chatReadMarksCopiedToConversationKeys
  writePersistedStateJson(dataFile, JSON.stringify(normalized))

  const selectiveSave = vi.spyOn(writeScheduling, 'scheduleSave')
  const fullSave = vi.spyOn(writeScheduling, 'scheduleFullProfileSave')
  const ui = createSqliteTestStore(Store, { dataFile }).getUI()
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ [TAB_KEY]: 100, [CONVERSATION_KEY]: 100 })
  expect(ui._chatReadMarksCopiedToConversationKeys).toBe(true)
  expect(selectiveSave).toHaveBeenCalledExactlyOnceWith(expect.anything(), ['ui'])
  expect(fullSave).not.toHaveBeenCalled()
})

it('takes the newer acknowledgement and preserves the existing cutoff and manual-unread mark', () => {
  const ui = load({
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 200, [CONVERSATION_KEY]: 100 },
    activityClearedAtByPaneKey: { [TAB_KEY]: 400, [CONVERSATION_KEY]: 300 },
    manuallyUnreadTurnsByPaneKey: { [TAB_KEY]: 600, [CONVERSATION_KEY]: 500 }
  })

  expect(ui).toMatchObject({
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 200, [CONVERSATION_KEY]: 200 },
    activityClearedAtByPaneKey: { [TAB_KEY]: 400, [CONVERSATION_KEY]: 300 },
    manuallyUnreadTurnsByPaneKey: { [TAB_KEY]: 600, [CONVERSATION_KEY]: 500 }
  })
})

it('does not copy again once a profile was copied, so a later Mark unread stays', () => {
  const ui = load({
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 100 },
    _chatReadMarksCopiedToConversationKeys: true
  })
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ [TAB_KEY]: 100 })
})
