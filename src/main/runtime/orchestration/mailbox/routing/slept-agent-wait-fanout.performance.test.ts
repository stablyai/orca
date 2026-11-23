import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  applySleepingMailChange,
  type SleepingMailChange
} from '../../../../../shared/workspace/lifecycle/sleeping-mail-change'

type Internals = {
  wokenHandlePtyId(handle: string): string | null
  wokenHandleChecks: Map<string, Set<() => void>>
  recordPtyWorktree(ptyId: string, worktreeId: string, options: { connected: boolean }): void
  requestSleptMailboxWake(mailbox: string): void
  terminalIdentity: {
    handles: ReadonlyMap<string, { ptyId: string | null }>
    setHandle(handle: string, record: unknown): void
  }
  terminalWait: { wait(handle: string): Promise<unknown> }
}

function sleeper(index: number, manual: boolean): SleepingAgentSessionRecord {
  const leaf = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
  return {
    paneKey: `tab-${index}:${leaf}`,
    tabId: `tab-${index}`,
    worktreeId: `folder:${index}`,
    terminalHandle: `term_${index}`,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `conversation-${index}` },
    prompt: '',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    restoreOnTabOpenOnly: manual
  }
}

function sleptStatus(paneKey: string, ptyId: string): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleep detection reads only paneKey, receivedAt and paneSleep.
  return { paneKey, receivedAt: 1, paneSleep: { ptyId } } as never
}

function notifier(members: Partial<RuntimeNotifier>): RuntimeNotifier {
  const byName = new Map<string | symbol, unknown>(Object.entries(members))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paths under test call only the given members; every other member is a no-op.
  return new Proxy(members, {
    get: (_target, key) => byName.get(key) ?? (() => {})
  }) as RuntimeNotifier
}

function oweMail(db: OrchestrationDb, record: SleepingAgentSessionRecord): string {
  const run = db.createRun({
    objective: 'owed',
    coordinatorHandle: null,
    coordinatorPaneKey: record.paneKey
  })
  db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
  return `run:${run.id}`
}

function mount(count: number, manual: boolean, owed = 0) {
  const db = new OrchestrationDb(':memory:')
  const records = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const record = sleeper(index, manual)
      return [record.paneKey, record]
    })
  )
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getWorkspaceSession: () => ({
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: records
      }),
      getWorkspaceSessionHostIds: () => ['local'],
      onWorkspaceSessionWritten: () => () => {}
    }),
    undefined,
    {
      getAgentStatusSnapshotForPane: (pane) => {
        const record = records[pane]
        return record ? [sleptStatus(pane, `stopped-${record.terminalHandle}`)] : []
      }
    }
  )
  Object.values(records)
    .slice(0, owed)
    .forEach((record) => oweMail(db, record))
  runtime.setOrchestrationDb(db)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the internals under test are runtime members these paths use.
  const internals = runtime as unknown as Internals
  return { db, runtime, internals, records: Object.values(records) }
}

const flush = () => vi.advanceTimersByTimeAsync(10)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([100, 1_000])(
  'identity writes re-check only the slept-agent waits on the handles they touch (%i waits)',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const { db, runtime, internals, records } = mount(count, false)
    const cancel = new AbortController()
    try {
      runtime.setNotifier(notifier({ resumeSleepingAgents: async () => true }))
      const windowGraph = (title: string) => ({
        tabs: records.map((record) => ({
          tabId: record.tabId!,
          worktreeId: record.worktreeId,
          title,
          activeLeafId: record.paneKey.split(':')[1],
          layout: null
        })),
        leaves: records.map((record) => ({
          tabId: record.tabId!,
          worktreeId: record.worktreeId,
          leafId: record.paneKey.split(':')[1],
          paneRuntimeId: 1,
          ptyId: null
        }))
      })
      await runtime.syncWindowGraph(1, windowGraph('Agent'))
      await vi.advanceTimersByTimeAsync(5_000)
      const handles = records.map((record) => runtime.getTerminalHandleForPaneKey(record.paneKey)!)
      expect(new Set(handles).size).toBe(count)
      const waiting = handles.map((handle) =>
        runtime
          .waitForTerminal(handle, { condition: 'exit', signal: cancel.signal })
          .catch(() => undefined)
      )
      await flush()
      expect(internals.wokenHandleChecks.size).toBe(count)
      const checks = vi.spyOn(internals, 'wokenHandlePtyId')

      for (let event = 0; event < 10; event += 1) {
        internals.recordPtyWorktree(`unrelated-${event}`, 'folder:unrelated', { connected: true })
        await flush()
      }
      expect(checks).toHaveBeenCalledTimes(0)
      // Graph publications that keep every pane (a title change) check no wait either.
      for (let event = 0; event < 10; event += 1) {
        await runtime.syncWindowGraph(1, windowGraph(`Agent ${event}`))
        await flush()
      }
      expect(checks).toHaveBeenCalledTimes(0)

      cancel.abort()
      await Promise.all(waiting)
      vi.spyOn(internals.terminalWait, 'wait').mockImplementation(async (handle) => ({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }))
      const joined = handles.map((handle) =>
        runtime.wakeSleptAgentHandle(handle, { timeoutMs: 120_000 })
      )
      await flush()
      checks.mockClear()
      // Each resumed process re-checks only its own handle's wait.
      handles.forEach((handle, index) => {
        internals.recordPtyWorktree(`resumed-${index}`, records[index].worktreeId, {
          connected: true
        })
        internals.terminalIdentity.setHandle(handle, {
          ...internals.terminalIdentity.handles.get(handle),
          ptyId: `resumed-${index}`
        })
      })
      await flush()
      await Promise.all(joined)
      expect(checks.mock.calls.length).toBeLessThanOrEqual(2 * count)
      expect(internals.wokenHandleChecks.size).toBe(0)
    } finally {
      cancel.abort()
      runtime.setNotifier(null)
      db.close()
    }
  },
  120_000
)

it.each([100, 1_000])(
  'held-workspace changes send only the workspaces that changed, once per tick (%i held)',
  async (held) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const burst = 50
    const { db, runtime, internals, records } = mount(held + burst, true, held)
    const bell = vi.fn<(change: SleepingMailChange) => void>()
    try {
      runtime.setNotifier(notifier({ sleepingMailChanged: bell }))
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(5_000)
      // A loaded window gets the whole set, then each workspace once as its hold lands.
      const loaded = new Set<string>()
      let sent = 0
      for (const [change] of bell.mock.calls) {
        applySleepingMailChange(loaded, change)
        sent +=
          'worktreeIds' in change
            ? change.worktreeIds.length
            : change.held.length + change.released.length
      }
      expect([...loaded].sort()).toEqual(
        records
          .slice(0, held)
          .map((r) => r.worktreeId)
          .sort()
      )
      expect(sent).toBeLessThanOrEqual(2 * held)
      bell.mockClear()

      const owed = records.slice(held).map((record) => oweMail(db, record))
      for (const mailbox of owed) {
        internals.requestSleptMailboxWake(mailbox)
      }
      await flush()
      expect(bell).toHaveBeenCalledTimes(1)
      expect(bell.mock.calls[0][0]).toEqual({
        held: records.slice(held).map((record) => record.worktreeId),
        released: []
      })
      bell.mockClear()

      const mail = db.getUndeliveredUnreadMessages(owed[0]).map((row) => row.id)
      db.markAsRead(mail, { kind: 'orca' })
      await flush()
      expect(bell.mock.calls.map(([change]) => change)).toEqual([
        { held: [], released: [records[held].worktreeId] }
      ])
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  },
  120_000
)
