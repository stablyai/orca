import '../orchestration/crew/crew-changes'
import { makeRuntimeOrchestrationDb } from './runtime-orchestration-db.test-fixture'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  HEADLESS_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  TEST_FOLDER_WORKSPACE_KEY,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import { publishLegacyWorkerReveal } from './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('adopts an exact live legacy worker in a folder workspace', async () => {
    const workerPaneKey = `legacy-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '66666666-6666-4666-8666-666666666666'
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-legacy-worker-folder-'))
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
        flushOrThrow: vi.fn()
      }),
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const orchestrationDb = makeRuntimeOrchestrationDb()
    vi.spyOn(orchestrationDb, 'listSessionDispatchesForPresentation').mockImplementation(() => [])
    vi.spyOn(orchestrationDb, 'listLegacyWorkerTerminalRecoveryRows').mockImplementation(() => [
      {
        dispatch_id: 'dispatch-folder',
        task_id: 'task-folder',
        dispatch_status: 'completed',
        contract_version: 0,
        assignee_handle: 'term_folder',
        assignee_pane_key: workerPaneKey,
        process_incarnation: `pty-folder-legacy:${incarnationId}`,
        worker_state: 'ready',
        worktree_id: TEST_FOLDER_WORKSPACE_KEY,
        agent_terminal_handle: 'term_folder'
      }
    ])
    runtime.setOrchestrationDb(orchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-folder-legacy',
        incarnationId,
        terminalHandle: 'term_folder',
        title: 'Folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-folder-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-folder'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-folder-worker',
        ptyId: 'pty-folder-legacy',
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith('local', LIST_PROVIDER_DEADLINE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-legacy',
      title: 'Folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_folder',
        incarnationId
      }
    })
  })
})
