import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { stopReportId } from '../../orchestration/workers/turn-stops/worker-turn-stop-report'
import { parseRelayedMessage } from '../../orchestration/legacy-remote-home/federation-sync-message'
import type { TerminalModelWait } from '../../../agent-hooks/server/server-model-wait'
import { RuntimeTerminalWorkerModelWait } from './terminal-worker-model-wait'

const HANDLE = 'term_worker'
const PANE = 'tab_worker:22222222-2222-4222-8222-222222222222'
const MINUTE = 60_000
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'

// Synthetic frames only. Each puts one sentinel where one way of picking a screen line would land,
// with no other row that could be picked instead.
type Frame = { name: string; sentinel: string; screen: readonly string[] }
const FRAMES: readonly Frame[] = [
  {
    name: 'a status row with arbitrary text after it',
    sentinel: 'SENTINEL_STATUS_SUFFIX_q4Rz',
    screen: [
      '⏺ Reading the config',
      '✻ Waiting for API response · SENTINEL_STATUS_SUFFIX_q4Rz',
      '❯',
      FOOTER
    ]
  },
  {
    name: 'a list bullet with status words, on its own',
    sentinel: 'SENTINEL_BULLET_m7Kd',
    screen: ['⏺ Notes', '* retrying SENTINEL_BULLET_m7Kd', '❯', FOOTER]
  },
  {
    name: 'an ordinary spinner with no status words',
    sentinel: 'SENTINEL_SPINNER_w2Hc',
    screen: ['⏺ Reading the config', '✻ Zigzagging… SENTINEL_SPINNER_w2Hc', '❯', FOOTER]
  },
  {
    name: 'a wrapped key tail and no spinner',
    // A key's tail wrapped onto its own row: alone it matches no credential shape.
    sentinel: 'Zq7Wx2Lp9Rt4'.repeat(4),
    screen: [
      '⏺ Bash(cat .env.local)',
      '  ⎿  ANTHROPIC_API_KEY=sk-ant-api03-',
      `     ${'Zq7Wx2Lp9Rt4'.repeat(4)}`,
      '❯',
      FOOTER
    ]
  }
]

let db: OrchestrationDb | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-11-22T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  db?.close()
  db = undefined
})

/** The real observer and reporter; only the pane lookups and the screen read are stubbed. */
function observer(
  store: OrchestrationDb,
  screen: readonly string[]
): RuntimeTerminalWorkerModelWait {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only the fields set here.
  return Object.assign(Object.create(RuntimeTerminalWorkerModelWait.prototype), {
    _orchestrationDb: store,
    workerTurnStopReportDeps: {
      getDb: () => store,
      isWaitingForMail: () => false,
      notify: () => {}
    },
    getTerminalHandleForPaneKey: (paneKey: string) => (paneKey === PANE ? HANDLE : null),
    resolveLeafForHandle: (handle: string) => (handle === HANDLE ? { ptyId: 'pty-1' } : null),
    // The same frame on every look: nothing is streaming.
    readLiveTerminalScreenLines: () => [...screen]
  }) as RuntimeTerminalWorkerModelWait
}

// The observer looks three times, 20 s apart, before it reports.
const LOOKS_MS = 40_000

/** Hooks went quiet 12 minutes before the report; every look is of that one stretch. */
function stalledStretch(): TerminalModelWait {
  return {
    since: Date.now() - 12 * MINUTE + LOOKS_MS,
    turnKey: 'turn-1',
    toolMaybeOpen: false,
    stillWaiting: () => true,
    toolSeenRunning: () => {},
    // No transcriptPath, so the transcript is never read: the generic wording, as before.
    firstTranscriptLook: () => true
  }
}

async function observeStalledStretch(
  watcher: RuntimeTerminalWorkerModelWait,
  wait: TerminalModelWait
): Promise<void> {
  const observed = watcher.observeWorkerModelWait(PANE, wait)
  await vi.advanceTimersByTimeAsync(LOOKS_MS)
  expect(await observed).toBe(true)
}

function expectNoScreenText(text: string, sentinel: string): void {
  expect(text).not.toContain(sentinel)
  expect(text).not.toContain('Last seen')
  expect(text).not.toContain('lastSeen')
}

/** Every message this machine holds, under any id or mailbox. */
function localMailCount(store: OrchestrationDb): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) always returns one row with n.
  return (store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
}

function localRoute(store: OrchestrationDb): { runId: string; taskId: string; dispatchId: string } {
  const run = store.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const task = store.createTask({ spec: 'work', runId: run.id })
  const dispatch = createRootDispatch(store, task.id, HANDLE, PANE)
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id }
}

function pairedRoute(store: OrchestrationDb): { dispatchId: string; taskId: string } {
  const dispatchId = 'ctx_paired_worker'
  const taskId = 'task_paired'
  store.createRemoteDispatchAttachment({
    runId: 'run-home',
    dispatchId,
    taskId,
    homePeerFingerprint: 'home_peer',
    protocolVersion: 3,
    runtimeEpoch: 'worker_epoch',
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'attach_paired',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'attach_hash_paired'
    }
  })
  store.prepareRemoteAttachmentAuthority({
    dispatchId,
    paneKey: PANE,
    processIncarnation: 'proc-1',
    worktreeId: 'wt-1',
    terminalHandle: HANDLE,
    setupState: 'ready',
    effects: []
  })
  store.recordRemoteAttachmentStage({ dispatchId, stage: 'input_accepted', state: 'ready' })
  return { dispatchId, taskId }
}

describe('a terminal Claude worker waiting on its model', () => {
  for (const frame of FRAMES) {
    it(`tells a local Run how long it waited, with nothing from ${frame.name}`, async () => {
      db = new OrchestrationDb(':memory:')
      const { runId, taskId, dispatchId } = localRoute(db)
      expect(db.getUnreadRunMailbox(runId, 100, ['escalation'])).toHaveLength(0)
      const watcher = observer(db, frame.screen)
      const wait = stalledStretch()
      const id = stopReportId(dispatchId, `model-waiting:${wait.turnKey}:${wait.since}`)

      await observeStalledStretch(watcher, wait)

      const mail = db.getUnreadRunMailbox(runId, 100, ['escalation'])
      expect(mail).toHaveLength(1)
      const [message] = mail
      expect(message).toMatchObject({
        id,
        from_handle: HANDLE,
        type: 'escalation',
        priority: 'high'
      })
      expect(message.body).toContain(HANDLE)
      expect(message.body).toContain(taskId)
      expect(message.body).toContain('12 min')
      expectNoScreenText(message.body, frame.sentinel)
      const payload = JSON.parse(message.payload ?? '{}')
      expect(payload).toEqual({ taskId, dispatchId, handle: HANDLE, modelWait: 'waiting' })
      expectNoScreenText(message.payload ?? '', frame.sentinel)

      // The same stretch again changes nothing.
      await observeStalledStretch(watcher, wait)
      const again = db.getUnreadRunMailbox(runId, 100, ['escalation'])
      expect(again).toHaveLength(1)
      expect(again[0]).toEqual(message)
    })

    it(`relays the same notice to a paired Run home, with nothing from ${frame.name}`, async () => {
      db = new OrchestrationDb(':memory:')
      const { dispatchId, taskId } = pairedRoute(db)
      expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(0)
      expect(localMailCount(db)).toBe(0)
      const watcher = observer(db, frame.screen)
      const wait = stalledStretch()
      const id = stopReportId(dispatchId, `model-waiting:${wait.turnKey}:${wait.since}`)

      await observeStalledStretch(watcher, wait)

      const relayed = db.listPendingFederationRelay(dispatchId, 'to_home')
      expect(relayed).toHaveLength(1)
      expect(relayed[0].message_id).toBe(id)
      // The Run home's own parser accepts it as a high-priority escalation from the worker.
      const outer = parseRelayedMessage(relayed[0].payload)
      expect(outer).toMatchObject({
        from: HANDLE,
        type: 'escalation',
        priority: 'high',
        threadId: null
      })
      expect(outer.body).toContain(HANDLE)
      expect(outer.body).toContain(taskId)
      expect(outer.body).toContain('12 min')
      expectNoScreenText(relayed[0].payload, frame.sentinel)
      expectNoScreenText(outer.body, frame.sentinel)
      const inner = JSON.parse(outer.payload ?? '{}')
      expect(inner).toEqual({ taskId, dispatchId, handle: HANDLE, modelWait: 'waiting' })
      expectNoScreenText(outer.payload ?? '', frame.sentinel)
      // A paired worker's notice goes home, not into this machine's mail.
      expect(localMailCount(db)).toBe(0)

      // The same stretch again changes nothing.
      await observeStalledStretch(watcher, wait)
      const again = db.listPendingFederationRelay(dispatchId, 'to_home')
      expect(again).toHaveLength(1)
      expect(again[0]).toEqual(relayed[0])
      expect(localMailCount(db)).toBe(0)
    })
  }
})
