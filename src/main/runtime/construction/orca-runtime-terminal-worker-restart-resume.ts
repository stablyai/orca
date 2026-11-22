import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration/orchestration-timing-budgets'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TerminalWorkerRestartResume } from '../orchestration/workers/restart-resume/terminal-worker-restart-resume'
import { waitForWorkerAgentReady } from '../terminal/wait/launched-agent-composer-readiness'
import { reopenWorkerTerminal } from '../rpc/methods/orchestration/worker/follow-up/worker-follow-up-placement'
import { OrcaRuntimeWithWindowlessTerminalActivity } from '../sidebar-inputs/temporal/orca-runtime-windowless-terminal-activity'

type RestartResumeRuntime = Pick<
  OrcaRuntimeService,
  | 'resumeAgentSessionInWorkspace'
  | 'getOrchestrationDispatchAuthority'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalHandleForPaneKey'
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

/** A resumed worker comes back the way a follow-up reopens a closed one, in its own conversation. */
function createTerminalWorkerRestartResume(
  runtime: RestartResumeRuntime,
  resumeWorkOnRestart: () => boolean,
  reportResting: (paneKey: string) => Promise<void>
): TerminalWorkerRestartResume {
  const resume = new TerminalWorkerRestartResume({
    getDb: () => runtime.getExistingOrchestrationDb(),
    resumeWorkOnRestart,
    reportResting,
    closeTerminal: (handle) => runtime.closeTerminal(handle),
    setTimer: unrefTimer,
    reopen: (worktreeId, session, mutationId) =>
      reopenWorkerTerminal(runtime, worktreeId, session, mutationId),
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
    sendPrompt: async (handle, prompt, requestId) => {
      const sent = await runtime.sendTerminalAgentPrompt(handle, prompt, {
        inputKind: 'orchestration',
        acceptQueued: true,
        observationTimeoutMs: RESTART_CONTINUE_OBSERVE_MS,
        requestId
      })
      // Only a provider that reports turns can prove a dropped prompt.
      return sent.prompt?.observation !== 'supported' || sent.prompt.stages.includes('turn_started')
    }
  })
  // A pane started again in place is bound once its resumed agent reports its conversation there.
  runtime.subscribeAgentProviderSessionChangesFn?.((sessions) => resume.observePaneAgents(sessions))
  return resume
}

/** Holds the terminal-worker restart resume, built once every terminal and launch method it uses exists. */
export abstract class OrcaRuntimeWithTerminalWorkerRestartResume extends OrcaRuntimeWithWindowlessTerminalActivity {
  protected readonly terminalWorkerRestartResume = createTerminalWorkerRestartResume(
    this,
    () => this.store?.getSettings?.()?.nativeChatResumeWorkOnRestart === true,
    (paneKey) => this.terminalWorkerTurnStops.reportRestingPane(paneKey)
  )
}
