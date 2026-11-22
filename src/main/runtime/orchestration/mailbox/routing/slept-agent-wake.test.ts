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
const MOVED_TAB_ID = '55555555-5555-4555-8555-555555555555'

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
      slept.rows = [statusRow({ receivedAt: 2 })]
      await runtime.syncWindowGraph(1, graph(WOKEN_PTY_ID))
      runtime.onPtyData(WOKEN_PTY_ID, '\x1b]0;Codex done\x07', 1)
      await runtime.serializeMainTerminalBuffer(WOKEN_PTY_ID)
      return true
    })
    runtime.setNotifier(wakeNotifier(resume))

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

  it('names a slept pane by its own handle, which a copied Terminal ID wakes', async () => {
    const { db, runtime, handle } = await sleptPane()

    expect(runtime.getTerminalHandleForPaneKey(PANE_KEY)).toBe(handle)
    db.close()
  })

  it("keeps naming the stopped process's identity, so a finished worker's output stays readable", async () => {
    const { db, runtime, handle } = await sleptPane()

    expect(runtime.getTerminalProcessIncarnation(handle)).toBe(`${PTY_ID}:mailbox-incarnation`)
    db.close()
  })

  it('ends an exit wait as exited when the slept pane is closed', async () => {
    const { db, runtime, handle } = await sleptPane()
    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })

    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await expect(waiting).resolves.toMatchObject({ handle, status: 'exited', satisfied: true })
    db.close()
  })

  it("waits on through Agent Sleep's stop when the exit wait began while the agent was awake", async () => {
    const db = createDatabase('orca-slept-wake-')
    const rows: AgentStatusIpcPayload[] = []
    const { runtime } = await createRuntime(db, { getAgentStatusSnapshotForPane: () => rows })
    await driveToLiveIdle(runtime)
    const handle = runtime.getTerminalHandleForPaneKey(PANE_KEY)!
    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })
    const settled = vi.fn()
    void waiting.then(settled, settled)

    rows.push(statusRow({ receivedAt: 1, paneSleep: { ptyId: PTY_ID } }))
    const settleStop = runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', 'mailbox-incarnation')
    await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
    settleStop(true)
    await runtime.syncWindowGraph(1, graph(null))
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await expect(waiting).resolves.toMatchObject({ handle, status: 'exited', satisfied: true })
    db.close()
  })

  it('keeps a moved slept pane its handle and its exit wait pending', async () => {
    const { db, runtime, handle } = await sleptPane()
    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })
    const settled = vi.fn()
    void waiting.then(settled, settled)

    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: MOVED_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: MOVED_TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })
    await Promise.resolve()

    expect(settled).not.toHaveBeenCalled()
    expect(runtime.sleptAgentHandleForPane(`${MOVED_TAB_ID}:${LEAF_ID}`)).toBe(handle)
    db.close()
  })
})

/** An idle agent pane that Agent Sleep stopped: main marked the exact process, and the pane has none. */
async function sleptPane() {
  const db = createDatabase('orca-slept-wake-')
  const slept: { db: typeof db; rows: AgentStatusIpcPayload[] } = { db, rows: [] }
  const { runtime } = await createRuntime(db, { getAgentStatusSnapshotForPane: () => slept.rows })
  await driveToLiveIdle(runtime)
  const handle = runtime.getTerminalHandleForPaneKey(PANE_KEY)!
  slept.rows = [statusRow({ receivedAt: 1, paneSleep: { ptyId: PTY_ID } })]
  const settleStop = runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', 'mailbox-incarnation')
  await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
  settleStop(true)
  await runtime.syncWindowGraph(1, graph(null))
  expect(runtime.sleptAgentHandleForPane(PANE_KEY)).toBe(handle)
  return Object.assign(slept, { runtime, handle })
}

/** A pane status row; the slept-pane paths read only paneKey, receivedAt and paneSleep from it. */
function statusRow(
  fields: Pick<AgentStatusIpcPayload, 'receivedAt' | 'paneSleep'>
): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slept-pane paths under test read only paneKey, receivedAt and paneSleep.
  return { paneKey: PANE_KEY, ...fields } as AgentStatusIpcPayload
}

/** A notifier whose only live member is the pane resume; every other notification is a no-op. */
function wakeNotifier(
  resumeSleepingAgents: RuntimeNotifier['resumeSleepingAgents']
): RuntimeNotifier {
  const members: Partial<RuntimeNotifier> = { resumeSleepingAgents }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every member the runtime calls is either resumeSleepingAgents or answered by a no-op stub.
  return new Proxy(members, {
    get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn())
  }) as RuntimeNotifier
}
