import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { returnValue?: unknown }, args: unknown) => unknown>()
}))

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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

const PANE_A = `tab-a:${leaf(1)}`
const PANE_B = `tab-b:${leaf(2)}`

function session(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-1']] },
        { id: 'tab-b', leaves: [[leaf(2), 'pty-2']] }
      ]
    }
  ])
}

function record(paneKey: string, capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: GIT_KEY,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${capturedAt}` },
    prompt: 'work',
    state: 'working',
    capturedAt,
    updatedAt: capturedAt
  }
}

function stage(state: WorkspaceSessionState) {
  const event: { returnValue?: unknown } = {}
  handlers.get('app:stage-before-unload-sync')!(event, {
    sessions: [{ state, hostId: 'local' }],
    ui: {}
  })
  return event.returnValue
}

describe('the quit checkpoint in a layout-owner build', () => {
  let store: ReturnType<typeof createStore>
  const quitRecords: SleepingAgentSessionRecord[] = []
  const quitResumeRecordsFor = vi.fn(() => quitRecords)
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    store = createStore()
    quitRecords.length = 0
    quitResumeRecordsFor.mockClear()
    registerRendererShutdownCheckpointHandler(store, quitResumeRecordsFor)
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps a wake main recorded that the window had not seen yet', () => {
    // Main woke tab-b (a phone showed it) after the window last saw its record.
    store.setWorkspaceSession(session(), 'local')
    const captured = record(PANE_A, 2)
    quitRecords.push(captured)

    stage({
      ...session(),
      sleepingAgentSessionsByPaneKey: { [PANE_A]: captured, [PANE_B]: record(PANE_B, 1) }
    })

    const records = store.getWorkspaceSession('local').sleepingAgentSessionsByPaneKey ?? {}
    expect(Object.keys(records)).toEqual([PANE_A])
  })
})
