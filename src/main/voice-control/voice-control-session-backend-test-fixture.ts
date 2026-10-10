import type { MessageRow } from '../runtime/orchestration/types'
import type { MessageWaitResult } from '../runtime/runtime-message-waiters'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlSettings,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot,
  VoiceUiAction,
  VoiceUiActionResult
} from '../../shared/voice-control-types'
import { RealtimeResponseGate } from './realtime-response-gate'
import type { VoiceControlSessionBackendDeps } from './voice-control-session-backend'
import type { VoiceCommandResult } from './voice-control-command-runner'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'
import { idleWorktreeSummary, rosterSummary } from './voice-control-session-backend-test-summaries'

export { PANE } from './voice-control-session-backend-test-summaries'

/**
 * Shared harness for the session-backend test files: the dep fakes (roster, dispatch,
 * launch, pump, screen, terminal), capture arrays, and small builders. Tests construct
 * VoiceControlSessionBackendImpl themselves so each file picks its own scenarios. The
 * worktree-ps summary builders live in voice-control-session-backend-test-summaries.ts.
 */

export const SETTINGS: VoiceControlSettings = {
  enabled: true,
  coordinatorVoice: 'marin',
  agentVoiceMode: 'per-agent',
  maxSessionMinutes: 0,
  customInstructions: ''
}

const CLEAN_COMMAND_RESULT: VoiceCommandResult = {
  exitCode: 0,
  stdout: 'all good\n',
  stderr: '',
  timedOut: false,
  truncated: false
}

const DEFAULT_SCREEN: VoiceScreenSnapshot = {
  view: 'worktree',
  worktreeName: 'oak',
  tabs: [{ title: 'README.md', contentType: 'file', active: true }],
  leftSidebarOpen: true,
  rightSidebar: null
}

export type HarnessOptions = {
  mail?: MessageRow[]
  agentState?: AgentStatusState
  commandResult?: VoiceCommandResult
  screen?: VoiceScreenSnapshot | null
  screenTree?: string | null
  uiActionResult?: VoiceUiActionResult | null
  terminalText?: string | null
  /** Adds the idle ci-type-checking-guard worktree (no running agent) to the roster. */
  idleWorktree?: boolean
  defaultLaunchAgent?: 'claude' | 'blank' | null
  /** Installed agent CLIs the preflight seam reports; empty = nothing installed. */
  installedAgents?: string[]
  launchError?: string
  /** Makes getRoster reject — a tool whose roster read throws must still answer the model. */
  rosterError?: string
  /** Makes the dispatch ceremony's createDispatchContext throw (the zombie-dispatch live failure). */
  dispatchError?: string
  /** The agent-liveness probe's answer; false = the pane is a bare shell (stale roster row). */
  agentRunning?: boolean
  /** Makes openUrl throw — the tab-create path's refusal must reach the model, not crash. */
  openUrlError?: string
  /** Stamps the roster worktree with an SSH hostId — run_command/start_agent must not
   *  answer a remote row with a client-local action. */
  remoteWorktree?: boolean
  /** Simulates a remote runtime driving this window — client-local tools refuse outright. */
  remoteRuntime?: boolean
  /** Stamps the IDLE worktree with an SSH hostId (start_agent's remote gate skip). */
  remoteIdleWorktree?: boolean
  /** Overrides the idle worktree's createdWithAgent history (null = no history). */
  idleWorktreeHistory?: TuiAgent | null
}

export function harness(options: HarnessOptions = {}) {
  const sent: Record<string, unknown>[] = []
  const toolActivity: VoiceControlToolActivityEvent[] = []
  const agentActivity: VoiceControlAgentActivityEvent[] = []
  const focused: { channel: string; payload: Record<string, unknown> }[][] = []
  const terminalPrompts: { handle: string; body: string }[] = []
  const transcript: VoiceTranscriptEntry[] = []
  const commands: { command: string; cwd: string }[] = []
  const uiActions: VoiceUiAction[] = []
  const openedUrls: string[] = []
  const launches: {
    worktreeId: string
    agent: string
    prompt: string
    title: string
    preAllocatedHandle: string
  }[] = []
  const gate = new RealtimeResponseGate((event) => sent.push(event), {
    recordCreateOutcome: () => {}
  })
  let mailArmed = false
  const deps: VoiceControlSessionBackendDeps = {
    sessionId: 's1',
    gate,
    send: (event) => sent.push(event),
    getSettings: () => SETTINGS,
    getRoster: () =>
      options.rosterError
        ? Promise.reject(new Error(options.rosterError))
        : Promise.resolve(
            options.idleWorktree
              ? [
                  ...rosterSummary(
                    options.agentState,
                    undefined,
                    options.remoteWorktree ? 'ssh:test-host' : undefined
                  ),
                  idleWorktreeSummary({
                    ...(options.remoteIdleWorktree ? { hostId: 'ssh:test-host' } : {}),
                    ...(options.idleWorktreeHistory !== undefined
                      ? { createdWithAgent: options.idleWorktreeHistory }
                      : {})
                  })
                ]
              : rosterSummary(
                  options.agentState,
                  undefined,
                  options.remoteWorktree ? 'ssh:test-host' : undefined
                )
          ),
    dispatch: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch calls only these two methods and reads only .id; the rest of the DB surface is fixture weight.
      db: {
        createTask: () => ({ id: 'task-1' }),
        createDispatchContext: () => {
          if (options.dispatchError) {
            throw new Error(options.dispatchError)
          }
          return { id: 'dispatch-1' }
        }
      } as never,
      runtime: {
        sendTerminalAgentPrompt: (handle: string, prompt: string) => {
          terminalPrompts.push({ handle, body: prompt })
          return Promise.resolve({})
        },
        getNestedWorkerMaxDepth: () => 2,
        isTerminalRunningAgent: () => Promise.resolve(options.agentRunning ?? true)
      },
      terminalHandleForPaneKey: () => 'term_abc'
    },
    launch: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch ceremony calls only these two methods and reads only .id; the rest of the DB surface is fixture weight.
      db: {
        createTask: () => ({ id: 'task-2' }),
        createDispatchContext: () => ({ id: 'dispatch-2' })
      } as never,
      getNestedWorkerMaxDepth: () => 2,
      launchAgentTerminal: (opts) => {
        launches.push(opts)
        return options.launchError
          ? Promise.reject(new Error(options.launchError))
          : Promise.resolve({})
      }
    },
    defaultLaunchAgent: () =>
      options.defaultLaunchAgent !== undefined ? options.defaultLaunchAgent : 'claude',
    disabledLaunchAgents: () => [],
    detectInstalledAgents: () => Promise.resolve(options.installedAgents ?? ['claude', 'codex']),
    openRun: () => ({ runId: 'run-1', mailboxHandle: 'run:run-1' }),
    pump: {
      waitForMessage: () => {
        if (!mailArmed && options.mail) {
          mailArmed = true
          return Promise.resolve<MessageWaitResult>('notified')
        }
        return new Promise<MessageWaitResult>(() => {})
      },
      getRunConsumerGeneration: () => 1,
      getRunDelivery: () =>
        options.mail ? { delivery: { id: 'd1' }, messages: options.mail } : undefined,
      acknowledgeRunDelivery: () => undefined
    },
    defaultCwd: () => Promise.resolve('/floating'),
    remoteRuntimeActive: () => options.remoteRuntime ?? false,
    runCommandProcess: (run) => {
      commands.push({ command: run.command, cwd: run.cwd })
      return Promise.resolve(options.commandResult ?? CLEAN_COMMAND_RESULT)
    },
    focusPane: (messages) => focused.push(messages),
    emitToolActivity: (event) => toolActivity.push(event),
    emitAgentActivity: (event) => agentActivity.push(event),
    recordTranscript: (entry) => transcript.push(entry),
    // Why not ??: null is a real fixture value here (owner window unreachable).
    describeScreen: () =>
      Promise.resolve(options.screen !== undefined ? options.screen : DEFAULT_SCREEN),
    seeScreen: () => Promise.resolve(options.screenTree ?? null),
    performUiAction: (action) => {
      uiActions.push(action)
      return Promise.resolve(options.uiActionResult !== undefined ? options.uiActionResult : null)
    },
    readTerminal: () => Promise.resolve(options.terminalText ?? null),
    openUrl: (url) => {
      openedUrls.push(url)
      return options.openUrlError
        ? Promise.reject(new Error(options.openUrlError))
        : Promise.resolve()
    }
  }
  return {
    deps,
    sent,
    toolActivity,
    agentActivity,
    focused,
    terminalPrompts,
    transcript,
    commands,
    uiActions,
    openedUrls,
    launches
  }
}

export function mailRow(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'm1',
    run_id: 'run-1',
    from_handle: 'term_abc',
    to_handle: 'run:run-1',
    subject: 'worker_done',
    body: 'tests are green',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-10-07T00:00:00Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

export function lastToolOutput(sent: Record<string, unknown>[]): string {
  const item = sent.toReversed().find((e) => e.type === 'conversation.item.create')
  const record =
    typeof item?.item === 'object' && item.item !== null
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object-checked test read of a wire event the backend itself produced.
        (item.item as Record<string, unknown>)
      : null
  return String(record?.output)
}
