import type { RuntimeTerminalWaitBlockedReason } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerDispatchRow } from '../../db/orchestration-records'
import { redactWorkerTerminalView } from '../../terminal-authority/views/worker-terminal-redaction'
import { observeWorker } from './worker-presence-report'
import { settleRestartCutWorkerStart } from '../../db/worker-dispatch/restart-cut-worker-start'
import { isWorkerAwaitingAgent } from '../../db/worker-dispatch/worker-awaiting-agent-stage'
import { reportFailedWorkerStart } from './failed-worker-start-report'

export const START_BLOCKED_FENCE = 'start-blocked'

const BLOCKED_SCREENS: Record<RuntimeTerminalWaitBlockedReason, string> = {
  'codex-update-prompt': 'an update prompt',
  'agent-update-prompt': 'an update prompt',
  'codex-trust-workspace': 'a workspace trust prompt',
  'agent-trust-workspace': 'a workspace trust prompt',
  'codex-cwd-prompt': 'a working-directory prompt',
  'agent-cwd-prompt': 'a working-directory prompt',
  'codex-model-migration-prompt': 'a model-change notice',
  'codex-hooks-review-prompt': 'a hooks review prompt',
  'agent-hooks-review-prompt': 'a hooks review prompt',
  'codex-interactive-prompt': 'a prompt',
  'agent-interactive-prompt': 'a prompt',
  'agent-approval-prompt': 'an approval prompt',
  'agent-sign-in-prompt': 'a sign-in screen',
  'agent-startup-menu-prompt': 'a startup menu'
}

/** The worker's last screen lines for a report, with any capability redacted; undefined when unreadable. */
export function readWorkerStartScreen(
  runtime: Pick<OrcaRuntimeService, 'readTerminal'>,
  handle: string
): Promise<string | undefined> {
  return Promise.resolve()
    .then(() => runtime.readTerminal(handle, { screen: true, limit: 15 }))
    .then((view) => {
      const { tail, draft } = redactWorkerTerminalView(view)
      // A held paste shows as a bare prompt; the composer's draft says what waits there.
      return [...tail, ...(draft ? [`Text waiting in its prompt: ${draft}`] : [])].join('\n')
    })
    .catch(() => undefined)
}

/** Told once per Dispatch, whichever screens follow: the coordinator only needs to fetch a person. */
export async function reportBlockedWorkerStart(
  runtime: Pick<OrcaRuntimeService, 'readTerminal' | 'notifyMessageArrived'>,
  db: OrchestrationDb,
  dispatchId: string,
  handle: string,
  reason: RuntimeTerminalWaitBlockedReason,
  readyBy: number
): Promise<void> {
  const screen = await readWorkerStartScreen(runtime, handle)
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || db.getWorkerDispatch(dispatchId)?.state !== 'starting') {
    return
  }
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'at-rest',
      fence: START_BLOCKED_FENCE,
      legacyStopKey: START_BLOCKED_FENCE,
      rest: {
        from: handle,
        reason: 'start-blocked',
        blockedStart: { screen: BLOCKED_SCREENS[reason], readyBy },
        lastOutput: screen
      }
    },
    {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: (to, type) => runtime.notifyMessageArrived(to, type)
    }
  )
}

/** A start that failed waiting for its agent: one report, which names the Dispatch's settlement. */
export function reportNeverReadyWorkerStart(
  db: OrchestrationDb,
  worker: WorkerDispatchRow,
  screen: string | undefined,
  notify: (handle: string, messageType: string) => void
): void {
  const dispatch = db.getDispatchContextById(worker.dispatch_id)
  if (!dispatch || worker.state !== 'failed') {
    return
  }
  const settled =
    dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
      ? dispatch.status
      : undefined
  observeWorker(
    db,
    { kind: 'local', dispatch },
    {
      presence: 'gone',
      fence: 'start',
      legacyStopKey: 'gone',
      gone: {
        from: worker.agent_terminal_handle ?? `dispatch:${dispatch.id}`,
        reason: 'never-ready',
        cause: worker.last_error ?? undefined,
        lastOutput: screen
      },
      settle: () => settled
    },
    { getDb: () => db, isWaitingForMail: () => false, notify }
  )
}

/** A start an earlier runtime left settles now, as its receipt would have. One still waiting on its agent
 *  had typed nothing and its wait died with that runtime, so it fails with the never-ready report. */
export function settleRestartCutStart(
  db: OrchestrationDb,
  dispatchId: string,
  runtime: Pick<OrcaRuntimeService, 'getRuntimeId' | 'notifyMessageArrived'>
): WorkerDispatchRow | undefined {
  const worker = db.getWorkerDispatch(dispatchId)
  const runtimeId = runtime.getRuntimeId()
  const cut = worker?.state === 'starting' && worker.runtime_epoch !== runtimeId
  // Cut before it bound a terminal or chat, it never got its brief; a paired server settles its own.
  if (cut && !worker.agent_terminal_handle && !db.getFederatedDispatch(dispatchId)) {
    const failed = db.failWorkerStart(
      dispatchId,
      worker.stage,
      'Orca restarted before this worker had a terminal or chat, so its agent never started.'
    )
    reportFailedWorkerStart(db, failed, (handle, type) =>
      runtime.notifyMessageArrived(handle, type)
    )
    return failed
  }
  if (!worker || !isWorkerAwaitingAgent(worker) || worker.runtime_epoch === runtimeId) {
    return settleRestartCutWorkerStart(db, dispatchId, runtimeId)
  }
  const failed = db.failWorkerStart(
    dispatchId,
    'agent_readiness',
    'Orca restarted while it waited for its agent, so it never typed its brief.'
  )
  reportNeverReadyWorkerStart(db, failed, undefined, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
  return failed
}
