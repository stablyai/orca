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

// A host with no window (orcad, `orca serve`, a closed desktop window) has no resumeSleepingAgents relay.
// Census row B5: the wake fails with agent_wake_failed in both modes; drop `.fails` once main wakes the pane itself.
it.fails('wakes a slept agent addressed by its handle when no window is attached', async () => {
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

  await expect(runtime.wakeSleptAgentHandle(handle, { timeoutMs: 3_000 })).resolves.toBe(handle)
})
