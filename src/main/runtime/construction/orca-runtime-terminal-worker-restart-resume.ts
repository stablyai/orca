import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration/orchestration-timing-budgets'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  TerminalWorkerRestartResume,
  type TerminalWorkerRestartResumeDeps
} from '../orchestration/workers/restart-resume/terminal-worker-restart-resume'
import { TerminalWorkerRestartOffers } from '../orchestration/workers/restart-resume/terminal-worker-restart-offers'
import { waitForWorkerAgentReady } from '../terminal/wait/launched-agent-composer-readiness'
import { reconsiderRestAfterWait } from '../orchestration/workers/turn-stops/worker-presence-report'
import {
  paneConversation,
  paneLiveSessions
} from '../orchestration/workers/restart-resume/pane-runs-conversation'
import { reopenWorkerTerminal } from '../rpc/methods/orchestration/worker/follow-up/worker-follow-up-placement'
import { workerStartAccount } from '../rpc/methods/orchestration/worker/follow-up/worker-earlier-work'
import { OrcaRuntimeWithWindowlessTerminalActivity } from '../sidebar-inputs/temporal/orca-runtime-windowless-terminal-activity'

type RestartResumeRuntime = Pick<
  OrcaRuntimeService,
  | 'resumeAgentSessionInWorkspace'
  | 'getOrchestrationDispatchAuthority'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalHandleForPaneKey'
  | 'getAgentStatusRowsForPane'
  | 'waitForTerminal'
  | 'waitForFreshWorkerComposer'
  | 'sendTerminalAgentPrompt'
  | 'getExistingOrchestrationDb'
  | 'subscribeAgentProviderSessionChangesFn'
  | 'closeTerminal'
>

/** How long a restart continue prompt has to start the resumed agent's turn. */
const RESTART_CONTINUE_OBSERVE_MS = 15_000

export function unrefTimer(run: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** Like a start's brief, the continue prompt's Enter is held while it would answer a dialog or
 *  submit someone's typing. */
export async function sendRestartContinuePrompt(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  prompt: string,
  requestId: string
): ReturnType<TerminalWorkerRestartResumeDeps['sendPrompt']> {
  const sent = await runtime.sendTerminalAgentPrompt(handle, prompt, {
    inputKind: 'orchestration',
    acceptQueued: true,
    observationTimeoutMs: RESTART_CONTINUE_OBSERVE_MS,
    requestId,
    withholdSubmitOnDialog: true
  })
  const submit = sent.prompt?.submit
  if (submit && 'withheldFor' in submit) {
    return { withheldFor: submit.withheldFor }
  }
  // Only a provider that reports turns can prove a dropped prompt.
  return sent.prompt?.observation !== 'supported' || sent.prompt.stages.includes('turn_started')
}

/** A resumed worker comes back the way a follow-up reopens a closed one, in its own conversation. */
function createTerminalWorkerRestartResume(
  runtime: RestartResumeRuntime,
  owners: Pick<
    TerminalWorkerRestartResumeDeps,
    | 'resumeWorkOnRestart'
    | 'reportResting'
    | 'reportContinueWithheld'
    | 'decideHeldRest'
    | 'offersChanged'
  >
): TerminalWorkerRestartResume {
  const resume = new TerminalWorkerRestartResume({
    ...owners,
    getDb: () => runtime.getExistingOrchestrationDb(),
    closeTerminal: (handle) => runtime.closeTerminal(handle),
    setTimer: unrefTimer,
    // Why the origin start's account: the resume recipe drops it, another account lacks the
    // conversation, and an in-place follow-up that owns the terminal now records none.
    reopen: (worktreeId, session, mutationId, dispatchId) => {
      const db = runtime.getExistingOrchestrationDb()
      const origin = db?.getWorkerTerminalResourceByOwner(dispatchId)?.origin_dispatch_id
      return reopenWorkerTerminal(
        runtime,
        worktreeId,
        session,
        mutationId,
        workerStartAccount(db, origin ?? dispatchId)
      )
    },
    terminalAuthority: (handle) => {
      const authority = runtime.getOrchestrationDispatchAuthority(handle)
      const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(handle)
      const processIncarnation =
        authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(handle)
      return paneKey && processIncarnation
        ? {
            paneKey,
            processIncarnation,
            ...(authority?.hostScope ? { hostScope: JSON.stringify(authority.hostScope) } : {})
          }
        : null
    },
    handleForPane: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey),
    paneConversation: (paneKey, sessionId) => paneConversation(runtime, paneKey, sessionId),
    paneSessions: (paneKey) => paneLiveSessions(runtime, paneKey),
    // A resumed agent is a fresh launch: its composer must be up, or it drops the prompt.
    waitForAgentReady: (handle, agent) =>
      waitForWorkerAgentReady(runtime, handle, {
        agent,
        reusesTerminal: false,
        timeoutMs: ORCHESTRATION_READINESS_TIMEOUT_MS
      }).then(
        (wait) => wait.satisfied,
        () => false
      ),
    sendPrompt: (handle, prompt, requestId) =>
      sendRestartContinuePrompt(runtime, handle, prompt, requestId)
  })
  // A pane started again in place is bound once its resumed agent reports its conversation there.
  runtime.subscribeAgentProviderSessionChangesFn?.((sessions) => resume.observePaneAgents(sessions))
  return resume
}

/** Holds the terminal-worker restart resume, built once every terminal and launch method it uses exists. */
export abstract class OrcaRuntimeWithTerminalWorkerRestartResume extends OrcaRuntimeWithWindowlessTerminalActivity {
  private offersNoticeQueued = false
  protected readonly terminalWorkerRestartResume = createTerminalWorkerRestartResume(this, {
    resumeWorkOnRestart: () => this.store?.getSettings?.()?.nativeChatResumeWorkOnRestart === true,
    reportResting: (paneKey) => this.terminalWorkerTurnStops.reportRestingPane(paneKey),
    reportContinueWithheld: (dispatchId, handle, hold) =>
      this.reportWithheldRestartContinue(dispatchId, handle, hold),
    decideHeldRest: (dispatchId) =>
      reconsiderRestAfterWait(`dispatch:${dispatchId}`, this.workerTurnStopReportDeps),
    // One notice per sweep, however many workers it offered.
    offersChanged: () => {
      if (!this.offersNoticeQueued) {
        this.offersNoticeQueued = true
        queueMicrotask(() => {
          this.offersNoticeQueued = false
          this.notifier?.restartOffersChanged?.()
        })
      }
    }
  })
  // A graph sync places a restarted pane's new process: its resumed agent may have reported already.
  protected readonly recheckAfterGraphSync = this.graphSyncCallbacks.push(() =>
    this.terminalWorkerRestartResume.recheckHeldPanes()
  )
  /** Offered terminal workers, shown and acted on beside the cut chats' restart offers. */
  readonly terminalWorkerRestartOffers = new TerminalWorkerRestartOffers({
    getDb: () => this.getExistingOrchestrationDb(),
    resume: this.terminalWorkerRestartResume,
    failLost: (dispatchId) => this.failLostRestartWorker(dispatchId)
  })
}
