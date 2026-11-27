import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { chatPaneKey } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { moveChatReadMarksAtLoad } from './chat-read-mark-move-at-load'
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

const SESSION_ID = 'session-2'
const CONVERSATION_KEY = chatPaneKey(SESSION_ID)
const TAB_KEY = `agent-chat-tab-v1-abc:${CONVERSATION_KEY.split(':').at(-1)}`
const WORKTREE = 'repo::/a|b'

function seed(): string {
  const dataFile = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'orca-read-mark-move-'))),
    'state.json'
  )
  const state = getDefaultPersistedState(tmpdir())
  state.repos = workspaceRepos(WORKTREE)
  state.workspaceSession = {
    ...state.workspaceSession,
    unifiedTabs: {
      [WORKTREE]: [
        {
          id: 'agent-chat-tab-v1-abc',
          entityId: SESSION_ID,
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

it('moves a saved tab’s marks and schedules only a UI save', async () => {
  const dataFile = seed()
  createSqliteTestStore(Store, { dataFile }).flushOrThrow()
  await closeTestStores()
  const normalized = readPersistedState(dataFile)
  normalized.ui.acknowledgedAgentsByPaneKey = { [TAB_KEY]: 200 }
  normalized.ui.activityClearedAtByPaneKey = { [TAB_KEY]: 400 }
  normalized.ui.manuallyUnreadTurnsByPaneKey = { [TAB_KEY]: 600 }
  writePersistedStateJson(dataFile, JSON.stringify(normalized))

  const selectiveSave = vi.spyOn(writeScheduling, 'scheduleSave')
  const fullSave = vi.spyOn(writeScheduling, 'scheduleFullProfileSave')
  const store = createSqliteTestStore(Store, { dataFile })
  expect(selectiveSave).toHaveBeenCalledExactlyOnceWith(expect.anything(), ['ui'])
  expect(fullSave).not.toHaveBeenCalled()
  store.flushOrThrow()

  const saved = readPersistedState(dataFile).ui
  expect(saved.acknowledgedAgentsByPaneKey).toEqual({ [CONVERSATION_KEY]: 200 })
  expect(saved.activityClearedAtByPaneKey).toEqual({ [CONVERSATION_KEY]: 400 })
  expect(saved.manuallyUnreadTurnsByPaneKey).toEqual({ [CONVERSATION_KEY]: 600 })
})

it.each([
  [200, 100],
  [100, 200]
])(
  'moves a closed chat using its canonical marks and keeps the newer stamps (%i, %i)',
  (old, chat) => {
    const state = getDefaultPersistedState(tmpdir())
    state.ui.acknowledgedAgentsByPaneKey = { [TAB_KEY]: old, [CONVERSATION_KEY]: chat }
    state.ui.activityClearedAtByPaneKey = { [TAB_KEY]: old + 200, [CONVERSATION_KEY]: chat + 200 }
    state.ui.manuallyUnreadTurnsByPaneKey = { [TAB_KEY]: old + 400, [CONVERSATION_KEY]: chat + 400 }

    const moved = moveChatReadMarksAtLoad(state)
    expect(moved.ui.acknowledgedAgentsByPaneKey).toEqual({ [CONVERSATION_KEY]: 200 })
    expect(moved.ui.activityClearedAtByPaneKey).toEqual({ [CONVERSATION_KEY]: 400 })
    expect(moved.ui.manuallyUnreadTurnsByPaneKey).toEqual({ [CONVERSATION_KEY]: 600 })
  }
)

it('skips saved tab discovery when all marks already use conversation keys', () => {
  const state = getDefaultPersistedState(tmpdir())
  state.ui.acknowledgedAgentsByPaneKey = { [CONVERSATION_KEY]: 200 }
  Object.defineProperty(state, 'workspaceSession', {
    get: () => {
      throw new Error('Unexpected tab discovery')
    }
  })

  expect(moveChatReadMarksAtLoad(state)).toBe(state)
})
