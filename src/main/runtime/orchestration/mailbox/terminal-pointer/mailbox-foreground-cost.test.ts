import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import { registerBoundPty } from '../../../orca-runtime-tests/bind-first-pane.test-fixture'
import {
  createDatabase,
  createRuntime,
  PTY_ID,
  PANE_KEY,
  TERMINAL_HANDLE,
  WORKTREE_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { countForegroundSqlWork } from './mailbox-foreground-work.test-fixture'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('terminal-owned foreground work', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  async function workload(held: number, mailboxes: number, unrelatedHooks: number) {
    const db = createDatabase('orca-mail-cost-')
    let projections = 0
    const rows: AgentStatusIpcPayload[] = Array.from({ length: unrelatedHooks }, (_, i) => ({
      paneKey: `unrelated:${i}`,
      connectionId: null,
      agentType: 'codex',
      state: 'working',
      prompt: '',
      receivedAt: Date.now(),
      stateStartedAt: 1
    }))
    const target: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      connectionId: null,
      agentType: 'codex',
      state: 'done',
      prompt: '',
      receivedAt: Date.now(),
      stateStartedAt: 1
    }
    const { runtime, write } = createRuntime(db, {
      headless: true,
      getAgentStatusSnapshot: () => {
        projections += rows.length + 1
        return [...rows, target]
      },
      getAgentStatusSnapshotForPane: (key) => {
        const matches = key === PANE_KEY ? [target] : []
        projections += matches.length
        return matches
      }
    })
    write.mockImplementation((ptyId, data) => {
      runtime.onPtyData(
        ptyId,
        data === '\r'
          ? '\x1b[37;3H\x1b[0m\x1b[K'
          : `\x1b[37;3H\x1b[0m\x1b[K${data.trim()}\x1b[37;3H`,
        Date.now()
      )
      return true
    })
    let inspections = 0
    let concurrent = 0
    let peak = 0
    let shell = true
    let retainInspections = true
    const releaseInspections: (() => void)[] = []
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getSize: () => ({ cols: 120, rows: 40 }),
      getForegroundProcess: async () => 'codex',
      supportsForegroundObservation: () => true,
      inspectProcess: async (ptyId) => {
        inspections++
        concurrent++
        peak = Math.max(peak, concurrent)
        if (retainInspections) {
          await new Promise<void>((resolve) => releaseInspections.push(resolve))
        }
        concurrent--
        return {
          foregroundProcess: shell ? 'zsh' : 'codex',
          hasChildProcesses: !shell,
          foregroundObservation: {
            ptyId,
            ptyIncarnationId: ptyId === PTY_ID ? 'mailbox-incarnation' : `inc-${ptyId}`,
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: shell ? 'shell' : 'non-shell',
            processName: shell ? 'zsh' : 'codex'
          }
        }
      }
    })
    const owners: { ptyId: string; handle: string; pane: string }[] = []
    for (let i = 0; i < held + 2; i++) {
      if (i === 0) {
        owners.push({ ptyId: PTY_ID, handle: TERMINAL_HANDLE, pane: PANE_KEY })
        continue
      }
      const ptyId = `pty-cost-${i}`
      const tabId = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      const leafId = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      registerBoundPty(runtime, ptyId, WORKTREE_ID, null, {
        tabId,
        leafId,
        incarnationId: `inc-${ptyId}`,
        agentLaunchAuthority: { launchToken: `cost-${i}`, launchAgent: 'codex' }
      })
      const handle = `term_cost_${i}`
      runtime.registerPreAllocatedHandleForPty(ptyId, handle)
      owners.push({ ptyId, handle, pane: `${tabId}:${leafId}` })
    }
    await runtime.listTerminals()
    for (const owner of owners.slice(0, held + 1)) {
      runtime.onPtyData(
        owner.ptyId,
        `${readRuntimeFixture('codex-0157-plain-ready')}\x1b]0;Codex done\x07`,
        Date.now()
      )
    }
    await vi.advanceTimersByTimeAsync(1000)
    const messages: string[] = []
    for (const owner of owners.slice(0, held)) {
      for (let m = 0; m < mailboxes; m++) {
        const run = db.createRun({
          objective: 'Held cost',
          coordinatorHandle: owner.handle,
          coordinatorPaneKey: owner.pane
        })
        messages.push(
          db.insertMessage({
            from: 'term_sender',
            to: `run:${run.id}`,
            subject: 'Owed mail',
            type: 'status',
            runId: run.id,
            deliveryContract: 'current_delivery'
          }).id
        )
      }
    }
    // This owner has mail but no live status; the other extra owner is live but has no mail.
    const empty = owners.at(-2)!
    const emptyRun = db.createRun({
      objective: 'Empty owner',
      coordinatorHandle: empty.handle,
      coordinatorPaneKey: empty.pane
    })
    const cold = owners.at(-1)!
    const coldRun = db.createRun({
      objective: 'Cold owner',
      coordinatorHandle: cold.handle,
      coordinatorPaneKey: cold.pane
    })
    db.insertMessage({
      from: 'term_sender',
      to: `run:${coldRun.id}`,
      subject: 'Cold mail',
      type: 'status',
      runId: coldRun.id,
      deliveryContract: 'current_delivery'
    })
    projections = 0
    const work = countForegroundSqlWork(db)
    for (const owner of owners) {
      runtime.requestMailDecision(owner.ptyId)
    }
    // A real semantic observation starts the batch; scheduling duplicates must not rediscover it.
    for (const owner of owners.slice(0, held)) {
      runtime.onPtyData(owner.ptyId, '\x1b]0;Codex working\x07', 2)
    }
    await vi.advanceTimersByTimeAsync(10)
    expect(concurrent).toBe(Math.min(held, 4))
    const pending = { ...work.counts }
    for (let i = 0; i < 10; i++) {
      for (const owner of owners.slice(0, held)) {
        runtime.requestMailDecision(owner.ptyId)
      }
    }
    await vi.advanceTimersByTimeAsync(0)
    const duplicateProbe = {
      statements: work.counts.statements - pending.statements,
      owners: work.counts.owners - pending.owners,
      messages: work.counts.messages - pending.messages
    }
    retainInspections = false
    for (const release of releaseInspections) {
      release()
    }
    await vi.advanceTimersByTimeAsync(1000)
    const initial = { ...work.counts }
    work.clear()
    for (let i = 0; i < 10; i++) {
      for (const owner of owners.slice(0, held)) {
        runtime.requestMailDecision(owner.ptyId)
      }
    }
    await vi.advanceTimersByTimeAsync(0)
    const duplicateTimer = { ...work.counts }
    work.clear()
    const startInspections = inspections
    await vi.advanceTimersByTimeAsync(600000)
    const periodic = { ...work.counts }
    const unowedOwnerVisits = work.ownerRows.filter(
      (id) => id === coldRun.id || id === emptyRun.id
    ).length
    const automatic = inspections - startInspections
    expect(write).not.toHaveBeenCalled()
    shell = false
    await vi.advanceTimersByTimeAsync(62000)
    expect(write).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20000 * mailboxes)
    expect(
      messages.every(
        (id) =>
          db.getMessageById(id)?.pointer_enter_pending === 0 &&
          db.getMessageById(id)?.delivered_at !== null
      )
    ).toBe(true)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(held * mailboxes)
    const result = {
      held,
      mailboxes,
      unrelatedHooks,
      initial,
      duplicateProbe,
      duplicateTimer,
      periodic,
      automatic,
      unowedOwnerVisits,
      projections,
      peak,
      plans: [...work.plans]
    }
    work.stop()
    db.close()
    return result
  }

  it('bounds H and silent recovery after capped backoff, with no periodic work for cold or empty owners', async () => {
    vi.useFakeTimers()
    const n = await workload(2, 1, 0)
    const tenN = await workload(20, 1, 0)
    expect(tenN.peak).toBe(4)
    for (const sample of [n, tenN]) {
      expect(sample.automatic).toBeGreaterThanOrEqual(10 * sample.held)
      expect(sample.automatic).toBeLessThanOrEqual(12 * sample.held)
      expect(sample.unowedOwnerVisits).toBe(0)
      expect(sample.peak).toBeLessThanOrEqual(4)
      expect(sample.periodic.owners).toBeLessThanOrEqual(200 * sample.held)
      expect(sample.periodic.messages).toBeLessThanOrEqual(200 * sample.held)
      expect(sample.periodic.statements).toBeLessThanOrEqual(1000 * sample.held)
      expect(sample.duplicateProbe).toEqual({ statements: 0, owners: 0, messages: 0 })
      expect(sample.duplicateTimer).toEqual({ statements: 0, owners: 0, messages: 0 })
    }
    console.info('rev7 H contract', JSON.stringify([n, tenN]))
  })

  it('bounds M owner-range SQL row work linearly for one terminal batch', async () => {
    vi.useFakeTimers()
    const n = await workload(1, 2, 0)
    const tenN = await workload(1, 20, 0)
    expect(n.initial.owners).toBeGreaterThan(0)
    expect(tenN.initial.owners).toBeLessThanOrEqual(10 * n.initial.owners)
    expect(tenN.initial.statements).toBeLessThanOrEqual(10 * n.initial.statements)
    expect(tenN.periodic.owners).toBeLessThanOrEqual(10 * n.periodic.owners)
    console.info('rev7 M contract', JSON.stringify([n, tenN]))
  })

  it('projects only scoped hook rows at A and 10A unrelated hook populations', async () => {
    vi.useFakeTimers()
    const n = await workload(1, 1, 10)
    const tenN = await workload(1, 1, 100)
    expect(n.projections).toBeGreaterThan(0)
    expect(tenN.projections).toBe(n.projections)
    expect(tenN.initial).toEqual(n.initial)
    expect(tenN.periodic).toEqual(n.periodic)
    console.info('rev7 A contract', JSON.stringify([n, tenN]))
  })
})
