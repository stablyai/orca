import { afterEach, expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { OrcaRuntimeWithAgentTransitions } from '../../../construction/orca-runtime-agent-transitions'
import { OrcaRuntimeWithApplyTrackedPtyTitle } from '../../../terminal/output/terminal-title-observation'
import { PANE } from '../../../../agent-hooks/server/testing/server.test-fixtures'

vi.mock('../../../sidebar-inputs/temporal/orca-runtime-windowless-terminal-activity', () => ({
  OrcaRuntimeWithWindowlessTerminalActivity: class {}
}))
vi.mock('../../../terminal/output/terminal-title-tracker', () => ({
  OrcaRuntimeWithGetUnpersistedTrackedTitleForPty: class {}
}))
vi.mock('../../../terminal/layout/hook-status-title-subscription', () => ({
  subscribeHookStatusTitles: () => () => {}
}))

const fixture = runtimeFixture()
let detach: (() => void) | undefined
afterEach(() => {
  detach?.()
  detach = undefined
})

it.each(['hook', 'title'])(
  'wakes an idle watch from a real %s observation and stops after teardown',
  (source) => {
    const { db, store, chat, changes } = fixture
    const { run, workers } = fixture.workers(1)
    chat.handles.clear()
    db.db.prepare("UPDATE dispatch_contexts SET created_at = '1970-01-01 00:00:00'").run()
    const handle = workers[0]!.assignee_handle!
    const pty = fixture.terminal(PANE, handle, false)
    const ptys = new Map([['pty-1', pty]])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invoke the real subscription and title edges with only their runtime dependencies; never construct or operate a PTY.
    const runtime = Object.assign(Object.create(OrcaRuntimeWithAgentTransitions.prototype), {
      crewChanges: changes,
      quietWorkerTitleWakes: new Set<() => void>(),
      _orchestrationDb: db,
      externalConversations: { current: () => null },
      agentTransitions: { attach: () => () => {} },
      workerTurnStopReportDeps: { notify: () => {} },
      terminalWorkerResolution: {
        getDb: () => db,
        getHandle: () => handle,
        getProcessIncarnation: () => 'process-1'
      },
      ptysById: ptys,
      paneOfPty: () => ({ paneKey: PANE }),
      getPtyRecordForPaneKey: (key: string) => fixture.panes.get(key) ?? null,
      observeClaudeTerminalEvidence: () => {},
      isLiveCursorNativeTitle: () => false,
      classifyPtyTitleStatus: () => 'working',
      setPtyManagementTitleFromObservedTitle: () => {},
      deliverPendingMessagesForPty: () => {},
      recordAgentPromptLifecycleState: () => {},
      nextTitleObservationSequence: () => 1,
      shouldDelayPtyBackedMobileSnapshotForForegroundAgent: () => false,
      orchestrationMailboxPointerDelivery: { observeAgentWorking: () => {} },
      getLeavesForPty: () => []
    }) as OrcaRuntimeWithAgentTransitions & OrcaRuntimeWithApplyTrackedPtyTitle
    detach = runtime.attachAgentStatusStore(store)
    vi.advanceTimersByTime(120_000)
    expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toEqual([])
    const crewNotify = vi.spyOn(changes, 'notify')
    if (source === 'hook') {
      store.ingestRemote(
        {
          paneKey: PANE,
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'work', agentType: 'codex' }
        },
        'conn-1'
      )
    } else {
      // A restored working title is not live evidence; its first live working repaint must wake.
      OrcaRuntimeWithApplyTrackedPtyTitle.prototype['applyTrackedPtyTitle'].call(
        runtime,
        'pty-1',
        'Custom working',
        'Custom working'
      )
    }
    if (source === 'title') {
      expect(crewNotify).not.toHaveBeenCalled()
    }
    vi.advanceTimersByTime(source === 'hook' ? 900_000 : 3_600_000)
    expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toHaveLength(1)
    ptys.clear()
    fixture.panes.clear()
    store.clearPaneState(PANE)
    changes.notify()
    vi.advanceTimersByTime(60_000)
    const reads = vi.spyOn(db, 'getActiveDispatchForTerminal')
    vi.advanceTimersByTime(600_000)
    expect(reads).not.toHaveBeenCalled()
    expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toHaveLength(1)
    runtime['onTitleAgentStatusChanged']()
    detach()
    detach = undefined
    const paneReads = vi.spyOn(runtime, 'getPtyRecordForPaneKey')
    store.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'new work', agentType: 'codex' }
      },
      'conn-1'
    )
    runtime['onTitleAgentStatusChanged']()
    changes.notify(new Set(['status']))
    changes.notify()
    vi.advanceTimersByTime(120_000)
    expect(paneReads).not.toHaveBeenCalled()
    expect(reads).not.toHaveBeenCalled()
  }
)
