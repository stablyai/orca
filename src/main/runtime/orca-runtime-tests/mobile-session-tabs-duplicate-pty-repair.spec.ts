import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import { planDuplicatePtyPaneRepair } from '../../persistence/terminal-topology/duplicate-pty-pane-repair'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'

// Windowless listing reads stored layout; duplicate PTY bindings need durable repair to avoid duplicate tabs.
const duplicate = makeWorkspaceSessionWithHeadlessTerminal({
  terminalLayoutsByTabId: {
    'host-tab': makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'persisted-pty',
      [HEADLESS_SECOND_LEAF_ID]: 'persisted-pty'
    })
  }
})

async function terminalRows(session: WorkspaceSessionState): Promise<number> {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  const snapshots = await runtime.listAllMobileSessionTabs()
  return (snapshots.find((snapshot) => snapshot.worktree === TEST_WORKTREE_ID)?.tabs ?? []).filter(
    (tab) => tab.type === 'terminal'
  ).length
}

describe('windowless mobile list of a terminal stored in two panes', () => {
  it('lists the stored duplicate twice (the reader that skips the Loader)', async () => {
    await expect(terminalRows(duplicate)).resolves.toBe(2)
  })

  it('lists one row once main has repaired the stored tree', async () => {
    await expect(terminalRows(planDuplicatePtyPaneRepair(duplicate)!.session)).resolves.toBe(1)
  })
})
