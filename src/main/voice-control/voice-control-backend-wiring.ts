import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolveFloatingTerminalCwd } from '../ipc/floating-workspace-directory'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlSettings,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot,
  VoiceUiAction,
  VoiceUiActionResult
} from '../../shared/voice-control-types'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import { runVoiceCommand } from './voice-control-command-runner'
import { openVoiceControlRun } from './voice-control-participant'
import { VoiceControlSessionBackendImpl } from './voice-control-session-backend'
import type { VoiceControlServiceDeps } from './voice-control-service'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'

/**
 * Binds the session backend's seams to the real runtime: the orchestration DB (run mailbox,
 * deliveries), terminal dispatch, the command runner, the floating-workspace cwd, and pane
 * focus via the owning window. Kept out of the service so the service stays transport-only
 * and the backend stays seam-injected for tests.
 */

export function createVoiceControlBackendFactory(args: {
  store: Store
  runtime: OrcaRuntimeService
  getSettings: () => VoiceControlSettings
  getRoster: () => Promise<RuntimeWorktreePsSummary[]>
  emitToolActivity: (event: VoiceControlToolActivityEvent) => void
  emitAgentActivity: (event: VoiceControlAgentActivityEvent) => void
  recordTranscript: (entry: VoiceTranscriptEntry) => void
  /** describe_screen's round-trip to the owner window; null when no owner or a timeout. */
  describeScreen: () => Promise<VoiceScreenSnapshot | null>
  /** see_screen's CDP snapshot of the owner window; null when the debugger can't attach. */
  seeScreen: () => Promise<string | null>
  /** click_element / type_into against see_screen refs; null when the screen is gone. */
  performUiAction: (action: VoiceUiAction) => Promise<VoiceUiActionResult | null>
  /** read_terminal: the visible text of the terminal pane(s) on screen. */
  readTerminal: () => Promise<string | null>
  focusPane: (messages: { channel: string; payload: Record<string, unknown> }[]) => void
}): VoiceControlServiceDeps['createBackend'] {
  const { store, runtime } = args

  return ({ sessionId, gate, send }) => {
    const db = runtime.getOrchestrationDb()
    return new VoiceControlSessionBackendImpl({
      sessionId,
      gate,
      send,
      getSettings: args.getSettings,
      getRoster: args.getRoster,
      dispatch: {
        db,
        runtime: {
          sendTerminalAgentPrompt: (handle, prompt, options) =>
            runtime.sendTerminalAgentPrompt(handle, prompt, options),
          getNestedWorkerMaxDepth: () => runtime.getNestedWorkerMaxDepth(),
          isTerminalRunningAgent: (handle) => runtime.isTerminalRunningAgent(handle),
          getTerminalOrchestrationCliCommand: (handle) =>
            runtime.getTerminalOrchestrationCliCommand(handle)
        },
        terminalHandleForPaneKey: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey)
      },
      launch: {
        db,
        getNestedWorkerMaxDepth: () => runtime.getNestedWorkerMaxDepth(),
        getOrchestrationCliCommand: (handle) => runtime.getTerminalOrchestrationCliCommand(handle),
        launchAgentTerminal: (opts) =>
          runtime.launchAgentTerminal(`id:${opts.worktreeId}`, {
            agent: opts.agent,
            prompt: opts.prompt,
            title: opts.title,
            preAllocatedHandle: opts.preAllocatedHandle
          })
      },
      // Raw settings values — the shared launch-agent picker applies the precedence
      // (history → default → auto-pick over installed), same as the new-workspace flow.
      defaultLaunchAgent: () => store.getSettings().defaultTuiAgent,
      disabledLaunchAgents: () => store.getSettings().disabledTuiAgents ?? [],
      detectInstalledAgents: () => detectInstalledAgentsWithShellPathHydration(),
      openRun: () => openVoiceControlRun(db),
      pump: {
        waitForMessage: (handle, options) => runtime.waitForMessage(handle, options),
        getRunConsumerGeneration: (runId) => db.getRun(runId)?.consumer_generation ?? null,
        getRunDelivery: (params) => db.getOrCreateRunDelivery(params),
        acknowledgeRunDelivery: (params) => db.acknowledgeRunDelivery(params)
      },
      defaultCwd: () => resolveFloatingTerminalCwd(store),
      // A runtime environment means this window's roster/agents live on the remote
      // host; client-local tools (run_command, the installed-agent scan) must refuse
      // rather than answer for the wrong machine (ssh-execution-boundary).
      remoteRuntimeActive: () => Boolean(store.getSettings().activeRuntimeEnvironmentId?.trim()),
      runCommandProcess: (options) => runVoiceCommand(options),
      focusPane: args.focusPane,
      emitToolActivity: args.emitToolActivity,
      emitAgentActivity: args.emitAgentActivity,
      recordTranscript: args.recordTranscript,
      describeScreen: args.describeScreen,
      seeScreen: args.seeScreen,
      performUiAction: args.performUiAction,
      readTerminal: args.readTerminal,
      // open_url rides the same renderer tab-create path as `orca browser tab create`:
      // no worktree → the window's ACTIVE workspace, activate → foregrounded. The voice
      // owner window is the app shell (AppRootSurfaces), which is the authoritative window
      // this targets. The renderer itself refuses while a remote runtime is active, and
      // that refusal reaches the model as the tool's error text.
      openUrl: (url) => runtime.browserTabCreate({ url, activate: true }).then(() => undefined)
    })
  }
}
