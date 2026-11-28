import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import {
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  LEAF_ID,
  PANE_KEY,
  PTY_ID,
  TAB_ID,
  temporaryDirectories,
  WORKTREE_ID
} from '../terminal-pointer/orchestration-mailbox-notification-test-harness'
import { registerBoundPty } from '../../../terminal/layout/bind-first-pane.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'

const WOKEN_PTY_ID = 'pty-woken'

const openDatabases: { close(): void }[] = []

afterEach(() => {
  // The expected failure throws before the test's end, so the handle is closed here.
  for (const db of openDatabases.splice(0)) {
    db.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// A host with no window relay (orcad, `orca serve`, a closed desktop window): main starts the pane it
// owns. With the switch off the window owns the pane, so the wake still fails there.
const itWakesWithoutWindow = ORCA_LAYOUT_OWNER_IS_MAIN ? it : it.fails
itWakesWithoutWindow(
  'wakes a slept agent addressed by its handle when no window is attached',
  async () => {
    const db = createDatabase('orca-slept-wake-no-window-')
    openDatabases.push(db)
    const rows: AgentStatusIpcPayload[] = []
    const { runtime } = await createRuntime(db, { getAgentStatusSnapshotForPane: () => rows })
    await driveToLiveIdle(runtime)
    const handle = runtime.getTerminalHandleForPaneKey(PANE_KEY)!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slept-pane paths read only paneKey, receivedAt and paneSleep.
    rows.push({
      paneKey: PANE_KEY,
      receivedAt: 1,
      paneSleep: { ptyId: PTY_ID }
    } as AgentStatusIpcPayload)
    const settleStop = runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', 'mailbox-incarnation')
    await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
    settleStop(true)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: null }
      ]
    })
    expect(runtime.sleptAgentHandleForPane(PANE_KEY)).toBe(handle)
    runtime.setNotifier(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a windowless notifier: no resumeSleepingAgents, every other member a no-op.
      new Proxy(
        {},
        { get: (_t, key) => (key === 'resumeSleepingAgents' ? undefined : vi.fn()) }
      ) as RuntimeNotifier
    )

    const starts: string[] = []
    // The process main spawns: it registers in the pane under the name the slept pane exports.
    runtime.startRestoredPane = async (pane) => {
      starts.push(`${pane.tabId}:${pane.leafId}`)
      registerBoundPty(runtime, WOKEN_PTY_ID, WORKTREE_ID, null, {
        tabId: pane.tabId,
        leafId: pane.leafId,
        incarnationId: 'woken-incarnation'
      })
      const name = runtime.sleptPaneHandleForSpawn(PANE_KEY)
      if (name) {
        runtime.registerPreAllocatedHandleForPty(WOKEN_PTY_ID, name)
      }
      rows.splice(0)
      queueMicrotask(() => runtime.onPtyData(WOKEN_PTY_ID, '\x1b]0;Codex done\x07', 1))
      return WOKEN_PTY_ID
    }

    await expect(runtime.wakeSleptAgentHandle(handle, { timeoutMs: 3_000 })).resolves.toBe(handle)
    expect(starts).toEqual([PANE_KEY])
  }
)
