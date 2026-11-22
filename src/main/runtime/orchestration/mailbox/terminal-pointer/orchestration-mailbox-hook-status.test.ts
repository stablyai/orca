import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  TAB_ID,
  temporaryDirectories,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

/** An agent with its terminal title turned off reports its status only by hook. */
async function titlelessCodexWithMail() {
  const rows: AgentStatusIpcPayload[] = []
  const listeners = new Set<(paneKey: string) => void>()
  const db = createDatabase('orca-mailbox-hook-status-')
  const harness = await createRuntime(db, {
    launchAgent: 'codex',
    getAgentStatusSnapshot: () => rows,
    subscribeAgentStatusRowChanges: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  await harness.runtime.listTerminals()
  const run = createBoundRun(db, 'Hook status Run')
  insertDirectRunMessage(db, run.id, 'Worker finished')
  const report = (row: Pick<AgentStatusIpcPayload, 'state' | 'agentType'>, at = Date.now()) => {
    const now = at
    rows.splice(0, rows.length, {
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      connectionId: null,
      launchToken: LAUNCH_TOKEN,
      prompt: '',
      receivedAt: now,
      stateStartedAt: now,
      ...row
    })
    for (const listener of listeners) {
      listener(PANE_KEY)
    }
  }
  return { ...harness, db, report }
}

describe('mail to an agent that reports status only by hook', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("takes the agent's own live turn-end report as status it takes mail at", async () => {
    vi.useFakeTimers()
    const { write, report, db } = await titlelessCodexWithMail()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pointerCount(write)).toBe(0)

    report({ state: 'done', agentType: 'codex' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(pointerCount(write)).toBe(1)
    db.close()
  })

  it('never takes a report from before the shell retitled the pane for a live agent', async () => {
    vi.useFakeTimers()
    const { runtime, write, report, db } = await titlelessCodexWithMail()
    const reportedAt = Date.now()
    await vi.advanceTimersByTimeAsync(100)
    // The agent left without an exit report; its shell's prompt title names no agent status.
    runtime.onPtyData(PTY_ID, '\x1b]0;~/repo\x07', Date.now())
    await runtime.serializeMainTerminalBuffer(PTY_ID)

    report({ state: 'done', agentType: 'codex' }, reportedAt)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it("never takes another program's report in that pane for the agent's", async () => {
    vi.useFakeTimers()
    const { write, report, db } = await titlelessCodexWithMail()

    report({ state: 'done', agentType: 'claude' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(pointerCount(write)).toBe(0)
    db.close()
  })
})
