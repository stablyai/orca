import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { resumeRecordFromStatus } from '../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords
} from '../runtime/terminal/stop/worktree-sleep-resume-records'
import { sleepingRecordKey } from '../agent-hooks/identity/sleeping-agent-records'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { returnValue?: unknown }, args: unknown) => unknown>()
}))

// The shipped window-owner route: the window's own snapshot is staged as it is.
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { returnValue?: unknown }, args: unknown) => unknown
    ) => {
      handlers.set(channel, handler)
    },
    on: (
      channel: string,
      handler: (event: { returnValue?: unknown }, args: unknown) => unknown
    ) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'

const PANE = `tab-a:${leaf(1)}`
const GUEST_PATH = '/home/u/.claude/projects/p/session-mango.jsonl'
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'session-mango',
  transcriptPath: GUEST_PATH
}

function session(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-1', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-1']] }] }
  ])
}

/** Main's own sleep of a WSL Claude agent whose last reply was MANGO, saved to `hostId`. */
async function mainSleptRecord(store: ReturnType<typeof createStore>, hostId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleep capture reads only the row's pane, agent, session, prompt, reply, connection and time.
  const row = {
    paneKey: PANE,
    agentType: 'claude',
    state: 'done',
    prompt: 'Reply with MANGO',
    lastAssistantMessage: 'MANGO',
    providerSession: PROVIDER_SESSION,
    connectionId: 'wsl:Ubuntu',
    receivedAt: 10
  } as unknown as AgentStatusIpcPayload
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId: GIT_KEY,
    paneKeysByPtyId: new Map([['pty-1', [PANE]]]),
    launchByPtyId: new Map(),
    readRows: () => [row],
    checkAgentPresence: null,
    capturedAt: 20
  })
  store.setWorkspaceSession(
    applyWorktreeSleepResumeRecords(store.getWorkspaceSession(hostId), capture, ['pty-1'])!,
    hostId
  )
}

/** The window's newer quit capture of the same conversation, made before it saw the reply or distro. */
function windowQuitRecord(overrides: { providerSessionId?: string } = {}) {
  return resumeRecordFromStatus({
    entry: {
      paneKey: PANE,
      agentType: 'claude',
      state: 'working',
      prompt: 'one more thing',
      updatedAt: 30,
      providerSession: { ...PROVIDER_SESSION, id: overrides.providerSessionId ?? 'session-mango' },
      connectionId: null
    },
    worktreeId: GIT_KEY,
    capturedAt: 30,
    origin: 'quit'
  })!
}

function addRepo(store: ReturnType<typeof createStore>) {
  store.addRepo({
    id: 'repo-1',
    path: '/Users/dev/orca',
    displayName: 'orca',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'folder'
  })
}

function stage(state: WorkspaceSessionState, hostId: string) {
  handlers.get('app:stage-before-unload-sync')!({}, { sessions: [{ state, hostId }], ui: {} })
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it.each([
  ['this host', 'local'],
  ['a host partition', toSshExecutionHostId('box')]
])(
  "keeps an asleep agent's reply and WSL distro through the quit snapshot on %s, after reopening",
  async (_, hostId) => {
    const store = createStore()
    addRepo(store)
    store.setWorkspaceSession(session(), hostId)
    registerRendererShutdownCheckpointHandler(store)
    await mainSleptRecord(store, hostId)
    const quit = windowQuitRecord()
    expect(quit).not.toHaveProperty('lastAssistantMessage')
    expect(quit).not.toHaveProperty('wslDistro')

    stage({ ...session(), sleepingAgentSessionsByPaneKey: { [PANE]: quit } }, hostId)
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const reopened =
      createStore().getWorkspaceSession(hostId).sleepingAgentSessionsByPaneKey?.[PANE]

    // The window's newer resume state wins; the conversation's summary and scope are kept.
    expect(reopened).toMatchObject({
      state: 'working',
      prompt: 'one more thing',
      lastAssistantMessage: 'MANGO',
      wslDistro: 'Ubuntu'
    })
    expect(sleepingRecordKey(reopened!, true)).toMatchObject({ wslDistro: 'Ubuntu' })
  }
)

it("gives another conversation in the pane none of the earlier one's reply or distro", async () => {
  const store = createStore()
  addRepo(store)
  store.setWorkspaceSession(session(), 'local')
  registerRendererShutdownCheckpointHandler(store)
  await mainSleptRecord(store, 'local')

  stage(
    {
      ...session(),
      sleepingAgentSessionsByPaneKey: { [PANE]: windowQuitRecord({ providerSessionId: 'other' }) }
    },
    'local'
  )

  const record = store.getWorkspaceSession('local').sleepingAgentSessionsByPaneKey?.[PANE]
  expect(record).not.toHaveProperty('lastAssistantMessage')
  expect(record).not.toHaveProperty('wslDistro')
})
