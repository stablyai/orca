import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AutomationService } from './service'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import { withShellRunCompletion } from './shell-run-completion'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const TAB_ID = 'shell-run-tab'
const LEAF_ID = '11111111-2222-4333-8444-555555555555'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'shell-run-pty'
const INCARNATION_ID = 'shell-run-incarnation'

describe('shell run completion through the execution runtime', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-shell-run-runtime-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([false, true])(
    'retains immediate output and completion across pruning and late acknowledgement (renderer reload: %s)',
    async (reloadRenderer) => {
      vi.resetModules()
      installFakeAppEnvironment({ getPath: () => testState.dir })
      const { Store } = await import('../persistence/loading-store/store')
      const { initDataPath } = await import('../persistence/loading-store/user-data-path')
      const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
      initDataPath()
      const store = new Store()
      store.addRepo({
        id: 'shell-run-repo',
        path: testState.dir,
        displayName: 'Shell run test',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git'
      })
      const workspaceId = `shell-run-repo::${testState.dir}`
      const automation = store.createAutomation({
        name: 'Shell receipt test',
        prompt: 'printf done',
        agentId: null,
        projectId: 'shell-run-repo',
        workspaceMode: 'existing',
        workspaceId,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: Date.now()
      })
      const run = store.createAutomationRun(automation, Date.now(), 'manual')
      const runtime = new OrcaRuntimeService(store)
      if (reloadRenderer) {
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: TAB_ID,
              worktreeId: workspaceId,
              title: 'Terminal',
              activeLeafId: LEAF_ID,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: TAB_ID,
              worktreeId: workspaceId,
              leafId: LEAF_ID,
              paneRuntimeId: 1,
              ptyId: PTY_ID
            }
          ]
        })
      } else {
        runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      }
      const service = new AutomationService(store, {
        terminalObserver: withShellRunCompletion(
          runtime,
          createRuntimeAutomationRunTerminalObserver(runtime)
        )
      })
      runtime.setAutomationService(service)

      const waitStarted = vi.spyOn(runtime, 'waitForTerminal')
      const subscribeExit = vi.spyOn(runtime, 'subscribeToPtyExit')
      try {
        await service.markDispatchResult({
          runId: run.id,
          status: 'dispatching',
          workspaceId,
          terminalSessionId: TAB_ID,
          terminalPaneKey: PANE_KEY,
          terminalPtyId: PTY_ID
        })
        runtime.registerPty(PTY_ID, workspaceId, null, {
          tabId: TAB_ID,
          leafId: LEAF_ID,
          incarnationId: INCARNATION_ID
        })
        await vi.waitFor(() =>
          expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
            status: 'dispatched',
            terminalPtyId: PTY_ID,
            terminalIncarnationId: INCARNATION_ID
          })
        )
        const terminal = runtime.resolveTerminalPane(PANE_KEY, workspaceId)

        if (reloadRenderer) {
          await vi.waitFor(() =>
            expect(subscribeExit).toHaveBeenCalledWith(PTY_ID, expect.any(Function))
          )
          expect(waitStarted).not.toHaveBeenCalled()
          expect(runtime.markRendererReloading(1)).not.toBeNull()
          runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
        }

        // A fast command can finish before the dispatch acknowledgement or any microtask.
        runtime.onPtyData(PTY_ID, 'finished before renderer acknowledgement\r\n', Date.now())
        runtime.onPtyData(PTY_ID, `\u001b]133;D;0;orca-automation:${run.id}\u0007`, Date.now())
        runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, {
          hostExitConfirmed: true,
          cause: { kind: 'exited', exitCode: 0 }
        })

        await vi.waitFor(() => {
          expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
            status: 'completed',
            terminalCommandExitCode: 0,
            outputSnapshot: {
              content: 'finished before renderer acknowledgement',
              truncated: false
            }
          })
        })
        expect(waitStarted).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ condition: 'exit' })
        )
        if (!reloadRenderer) {
          expect((await runtime.readTerminal(terminal.handle)).tail).toEqual([])
        }

        const lateAcknowledgement = await service.markDispatchResult({
          runId: run.id,
          status: 'dispatched',
          terminalSessionId: TAB_ID,
          terminalPaneKey: PANE_KEY,
          terminalPtyId: PTY_ID
        })
        expect(lateAcknowledgement.status).toBe('completed')

        const reloaded = new Store()
        expect(reloaded.listAutomationRuns(automation.id)[0]).toMatchObject({
          status: 'completed',
          terminalCommandExitCode: 0,
          terminalIncarnationId: INCARNATION_ID,
          outputSnapshot: { content: 'finished before renderer acknowledgement' }
        })
      } finally {
        service.stop()
      }
    }
  )
})
