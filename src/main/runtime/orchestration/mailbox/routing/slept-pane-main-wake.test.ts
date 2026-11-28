import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import {
  closeTabFirst,
  registerBoundPty
} from '../../../terminal/layout/bind-first-pane.test-fixture'
import { storeOf } from '../../../terminal/layout/profile-session-store.test-fixture'
import type { RestoredPaneTrigger } from '../../../terminal/recovery/restored-pane-start'
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

/** With the switch on, main owns the pane, so main starts every slept-pane wake itself. */
describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('main wakes a slept pane it owns', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('starts one process when a handle wake and a workspace wake race', async () => {
    const slept = await agentSleptPane()
    const starts = recordStarts(slept.runtime)
    const handleWake = slept.runtime.wakeSleptAgentHandle(slept.handle, { timeoutMs: 5_000 })
    const workspaceWake = slept.runtime.resumeSleptWorkspaceAgents(WORKTREE_ID)

    await expect(handleWake).resolves.toBe(slept.handle)
    await workspaceWake
    expect(starts).toEqual([{ paneKey: PANE_KEY, launchToken: undefined }])
    slept.db.close()
  })

  it("launches a mail wake's resume under the wake's attempt id", async () => {
    const slept = await agentSleptPane()
    const starts = recordStarts(slept.runtime)

    await expect(resumeSleptPane(slept.runtime, { launchToken: 'mail-wake-1' })).resolves.toBe(true)
    expect(starts).toEqual([{ paneKey: PANE_KEY, launchToken: 'mail-wake-1' }])
    slept.db.close()
  })

  it('leaves a tab-open-only pane asleep on a workspace wake', async () => {
    const slept = await agentSleptPane({ origin: 'quit', restoreOnTabOpenOnly: true })
    const starts = recordStarts(slept.runtime)

    await slept.runtime.resumeSleptWorkspaceAgents(WORKTREE_ID)
    expect(starts).toEqual([])

    persistSleepRecord(slept.runtime, { origin: 'quit' })
    await slept.runtime.resumeSleptWorkspaceAgents(WORKTREE_ID)
    expect(starts).toEqual([{ paneKey: PANE_KEY, launchToken: undefined }])
    slept.db.close()
  })

  it('starts nothing for a pane closed before its wake', async () => {
    const slept = await agentSleptPane()
    const starts = recordStarts(slept.runtime)
    closeTabFirst(slept.runtime, { worktreeId: WORKTREE_ID, tabId: TAB_ID })

    await expect(resumeSleptPane(slept.runtime, {})).resolves.toBe(false)
    await slept.runtime.resumeSleptWorkspaceAgents(WORKTREE_ID)
    expect(starts).toEqual([])
    slept.db.close()
  })

  it('lists and shows a slept agent as the writable idle agent, with no stopped terminal', async () => {
    const slept = await agentSleptPane()
    const listed = (await slept.runtime.listTerminals()).terminals.find(
      (terminal) => terminal.handle === slept.handle
    )

    expect(listed).toMatchObject({ ptyId: null, connected: true, writable: true })
    await expect(slept.runtime.showTerminal(slept.handle)).resolves.toMatchObject({
      ptyId: null,
      writable: true
    })
    slept.db.close()
  })
})

/** An idle agent that Agent Sleep stopped in-session, its sleep record saved where main's layout
 *  reads it, and no window graph since. */
async function agentSleptPane(fields: Partial<SleepingAgentSessionRecord> = {}) {
  const db = createDatabase('orca-slept-main-wake-')
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
  persistSleepRecord(runtime, { terminalHandle: handle, ...fields })
  // Main re-composes its panes on the exit, with no window graph.
  await new Promise((resolve) => setImmediate(resolve))
  rows.splice(0)
  return { db, runtime, handle }
}

function persistSleepRecord(
  runtime: Awaited<ReturnType<typeof createRuntime>>['runtime'],
  fields: Partial<SleepingAgentSessionRecord>
): void {
  const store = storeOf(runtime)!
  const session = store.getWorkspaceSession!('local')!
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    origin: 'worktree-sleep',
    state: 'done',
    prompt: '',
    providerSession: { key: 'session_id', id: 'slept-session' },
    capturedAt: 1,
    updatedAt: 1,
    ...fields
  }
  store.setWorkspaceSession!(
    {
      ...session,
      sleepingAgentSessionsByPaneKey: {
        ...session.sleepingAgentSessionsByPaneKey,
        [PANE_KEY]: record
      }
    },
    'local'
  )
}

/** Main's starts, each answered by a resumed agent that turns idle in the pane under its saved name. */
function recordStarts(runtime: Awaited<ReturnType<typeof createRuntime>>['runtime']) {
  const starts: { paneKey: string; launchToken: string | undefined }[] = []
  runtime.startRestoredPane = async (pane, trigger: RestoredPaneTrigger) => {
    const paneKey = `${pane.tabId}:${pane.leafId}`
    starts.push({ paneKey, launchToken: trigger.launchToken })
    const name = runtime.sleptPaneHandleForSpawn(paneKey)
    registerBoundPty(runtime, WOKEN_PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'woken-incarnation'
    })
    if (name) {
      runtime.registerPreAllocatedHandleForPty(WOKEN_PTY_ID, name)
    }
    queueMicrotask(() => runtime.onPtyData(WOKEN_PTY_ID, '\x1b]0;Codex done\x07', 1))
    return WOKEN_PTY_ID
  }
  return starts
}

function resumeSleptPane(
  runtime: Awaited<ReturnType<typeof createRuntime>>['runtime'],
  opts: { launchToken?: string }
): Promise<boolean> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the one protected resume every slept-pane wake takes.
  const resume = (
    runtime as unknown as {
      resumeSleptPaneTerminal: (
        worktreeId: string,
        paneKey: string,
        opts: object
      ) => Promise<boolean>
    }
  ).resumeSleptPaneTerminal.bind(runtime)
  return resume(WORKTREE_ID, PANE_KEY, opts)
}
