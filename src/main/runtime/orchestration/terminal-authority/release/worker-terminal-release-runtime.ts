import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { StructuredSessionSurfaceRuntime } from '../../../agent-session/lifecycle/structured-agent-session-close'

export type WorkerTerminalReleaseRuntime = StructuredSessionSurfaceRuntime &
  Pick<
    OrcaRuntimeService,
    | 'forgetStructuredSessionMail'
    | 'resolveOrchestrationWorkerServer'
    | 'callOrchestrationWorkerServer'
    | 'getOrchestrationFleetAgentStatusSnapshot'
    | 'getOrchestrationDb'
    | 'getExistingOrchestrationDb'
    | 'showTerminal'
    | 'resolveTerminalHandleByProcessIncarnation'
    | 'getTerminalPaneKey'
    | 'getTerminalHandleForPaneKey'
    | 'getTerminalProcessIncarnation'
    | 'getTerminalLivenessVerdict'
    | 'checkTerminalAgentPresence'
    | 'getOrchestrationDispatchAuthority'
    | 'ensureStructuredAgentSessionHost'
    | 'inspectTerminalProcessIncarnationLiveness'
    | 'closeTerminal'
    | 'isSetupTerminalRunning'
    | 'getExactWorkerProviderSession'
    | 'readTerminal'
    | 'notifyMessageArrived'
    | 'isWorkerAgentInTurn'
  > &
  // Lower runtime layers declare neither; without them a release closes its chat.
  Partial<
    Pick<
      OrcaRuntimeService,
      'sleepWorkspaces' | 'bots' | 'listMobileSessionTabs' | 'savedTabsForWorktree'
    >
  >
