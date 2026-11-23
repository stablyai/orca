import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import {
  closeTestStores,
  createSqliteTestStore,
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
afterEach(() => closeTestStores())

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const TAB_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`
const WORKTREE = 'repo::/a|b'

function load(ui: Record<string, unknown>) {
  const dataFile = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'orca-read-mark-copy-'))),
    'state.json'
  )
  const state = getDefaultPersistedState(tmpdir())
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
  return createSqliteTestStore(Store, { dataFile }).getUI()
}

it('copies a reopened chat tab’s saved acknowledgement to its conversation key once, keeping the original', () => {
  const ui = load({ acknowledgedAgentsByPaneKey: { [TAB_KEY]: 100 } })
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ [TAB_KEY]: 100, [CONVERSATION_KEY]: 100 })
  expect(ui._chatReadMarksCopiedToConversationKeys).toBe(true)
})

it('does not copy again once a profile was copied, so a later Mark unread stays', () => {
  const ui = load({
    acknowledgedAgentsByPaneKey: { [TAB_KEY]: 100 },
    _chatReadMarksCopiedToConversationKeys: true
  })
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ [TAB_KEY]: 100 })
})
