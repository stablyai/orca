import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { registerBoundPty } from '../../../terminal/layout/bind-first-pane.test-fixture'
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

const WOKEN_PTY_ID = 'pty-woken'

function graph(ptyId: string | null) {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [{ tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId }]
  }
}

describe('Agent-slept window pane wake', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('settles under the same handle once the resumed agent is idle in the pane', async () => {
    const slept = await sleptPane()
    const { runtime, handle } = slept
    const resume = vi.fn(async () => {
      registerBoundPty(runtime, WOKEN_PTY_ID, WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'woken-incarnation'
      })
      slept.rows = [{ paneKey: PANE_KEY, receivedAt: 2 } as AgentStatusIpcPayload]
      await runtime.syncWindowGraph(1, graph(WOKEN_PTY_ID))
      runtime.onPtyData(WOKEN_PTY_ID, '\x1b]0;Codex done\x07', 1)
      await runtime.serializeMainTerminalBuffer(WOKEN_PTY_ID)
      return true
    })
    runtime.setNotifier(
      new Proxy({ resumeSleepingAgents: resume } as Record<string, unknown>, {
        get: (target, key: string) => target[key] ?? vi.fn()
      }) as unknown as RuntimeNotifier
    )

    const first = runtime.wakeSleptAgentHandle(handle, { timeoutMs: 5_000 })
    await vi.waitFor(() => expect(resume).toHaveBeenCalled())
    // A second act after the bind still joins the same wake rather than writing early.
    const second = runtime.wakeSleptAgentHandle(handle, { timeoutMs: 5_000 })

    await expect(first).resolves.toBe(handle)
    await expect(second).resolves.toBe(handle)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(runtime.getTerminalHandleForPaneKey(PANE_KEY)).toBe(handle)
    slept.db.close()
  })

  it('ends an exit wait as exited when the slept pane is closed', async () => {
    const { db, runtime, handle } = await sleptPane()
    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })

    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await expect(waiting).resolves.toMatchObject({ handle, status: 'exited', satisfied: true })
    db.close()
  })
})

/** An idle agent pane that Agent Sleep stopped: main marked the exact process, and the pane has none. */
async function sleptPane() {
  const db = createDatabase('orca-slept-wake-')
  const slept = { db, rows: [] as AgentStatusIpcPayload[] }
  const { runtime } = await createRuntime(db, { getAgentStatusSnapshotForPane: () => slept.rows })
  await driveToLiveIdle(runtime)
  const handle = runtime.getTerminalHandleForPaneKey(PANE_KEY)!
  slept.rows = [
    { paneKey: PANE_KEY, receivedAt: 1, paneSleep: { ptyId: PTY_ID } } as AgentStatusIpcPayload
  ]
  const settleStop = runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', 'mailbox-incarnation')
  await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
  settleStop(true)
  await runtime.syncWindowGraph(1, graph(null))
  expect(runtime.sleptAgentHandleForPane(PANE_KEY)).toBe(handle)
  return Object.assign(slept, { runtime, handle })
}
