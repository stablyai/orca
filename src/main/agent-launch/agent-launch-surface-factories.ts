import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
/**
 * The factories `executeAgentLaunch` is handed: how a surface and a workspace are BUILT once the
 * executor has decided which. Separate from the executor because they are the contract each caller
 * implements, not part of the sequencing it runs.
 */

import type {
  AgentLaunchIntent,
  AgentLaunchPrompt,
  AgentLaunchMode
} from '../../shared/agent-launch-intent'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionFirstMessage } from '../../shared/structured-agent-session-create'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import { toAgentLaunchPreferences } from '../../shared/agent-launch-preferences'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'

/** Inject creation so orchestration can add subscriptions without duplicating launch sequencing. */
export type AgentLaunchSurfaceFactory = {
  createStructuredSession(args: {
    worktreeId: string
    agent: StructuredAgentId
    chatOptions?: Readonly<Record<string, string>>
    options?: Readonly<Record<string, unknown>>
    /** Caller-minted ID; reject with AgentLaunchSessionAlreadyExistsError if taken. */
    sessionId?: string
    /** Caller-reserved tab ID; omit to use the ID clients derive. */
    tabId?: string
    /** Keep chat idle until the caller submits its first message. */
    withoutPrompt?: true
    firstMessage?: StructuredAgentSessionFirstMessage
    signal?: AbortSignal
  }): Promise<AgentLaunchStructuredSurface>
  createTerminalAgent(args: {
    worktreeId: string
    agent: TuiAgent
    options?: Readonly<Record<string, unknown>>
    /** Offer on argv; promptRodeLaunchCommand confirms whether the typed line carried it. */
    startupPrompt?: string
    /** Replaces the settings default for this launch only; `null` means no arguments at all. */
    agentArgs?: string | null
    cwd?: string
    launchSource?: string
    /** Caller-minted pane; reject with AgentLaunchPaneAlreadyLiveError if live. */
    paneKey?: string
    viewMode?: 'terminal' | 'chat'
    /** Account routing overrides merged over the agent environment. */
    accountEnv?: Readonly<Record<string, string>>
  }): Promise<{
    handle: string
    /** Omit when the runtime reports no pane; never invent one. */
    paneKey?: string
    warning?: string
    terminalCreation?: RuntimeTerminalCreate
    promptRodeLaunchCommand?: boolean
  }>
  /** Paste into a live PTY; return false on failure without failing the running launch. */
  deliverTerminalPrompt?(args: {
    handle: string
    agent: TuiAgent
    /** Reused terminals have no fresh launch readiness signal to await. */
    freshLaunch: boolean
    terminalCreation?: RuntimeTerminalCreate
    prompt: AgentLaunchPrompt
    /** Abort readiness waits and refuse pending pastes. */
    signal?: AbortSignal
  }): Promise<boolean>
}

/** The created chat and its committed opening submission. */
export type AgentLaunchStructuredSurface = {
  sessionId: string
  handle: string
  fence: number
  firstMessage?: { clientMessageId: string }
  /** Older hosts may omit the host-owned tab ID. */
  tabId?: string
}

/** Proves no session was committed, permitting terminal fallback. */
export class AgentLaunchStructuredSessionRefusedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentLaunchStructuredSessionRefusedError'
    this.code = code
  }
}

export type AgentLaunchWorkspaceFactory = {
  createWorktree(args: {
    create: Readonly<Record<string, unknown>>
    /** Register before announcing the workspace. */
    onWorkspaceCreated?: (worktreeId: string) => void
    promisedAgentChat?: boolean
    /** Terminal startup runs behind setup; structured launches must await setup explicitly. */
    startupAgent: TuiAgent | undefined
    /** The startup command builder measures whether this argv prompt fits. */
    startupPrompt?: string
    /** Legacy delivery lets the create own all prompt lengths and agents. */
    legacyPrompt?: AgentLaunchPrompt
    agentArgs?: string | null
    cwd?: string
    launchSource?: string
    paneKey?: string
    options?: Readonly<Record<string, unknown>>
    /** Account routing overrides merged over the startup agent environment. */
    accountEnv?: Readonly<Record<string, string>>
  }): Promise<{
    worktreeId: string
    /** Host-resolved root, available only after creation. */
    workspacePath?: string
    /** Null means local; absent means unresolved. */
    connectionId?: string | null
    startupTerminalHandle: string | undefined
    startupTerminalCreation?: RuntimeTerminalCreate
    startupTerminalPaneKey?: string
    warning?: string
    promptRodeLaunchCommand?: boolean
  }>
  /** Leave a usable workspace when chat creation has an indeterminate outcome. */
  createRecoveryShell?: (worktreeId: string) => Promise<void>
  /** Folders have no startup terminal; the executor launches their agent after creation. */
  createFolderWorkspace?(args: {
    create: Readonly<Record<string, unknown>>
  }): Promise<{ worktreeId: string; workspacePath?: string; connectionId: string | null }>
}

/** The options a terminal leg starts with: a caller's saved chat choice applies to it too. */
function terminalLaunchOptions(intent: Pick<AgentLaunchIntent, 'sessionOptions' | 'chatOptions'>) {
  return intent.sessionOptions ?? intent.chatOptions
}

/** Refuses, before anything exists, an OpenCode terminal its host cannot verify, read as that
 *  terminal will receive it, after the shared preflight determines the actual route. */
export function assertTerminalLaunchAdmissible(
  intent: AgentLaunchIntent | AgentLaunchParams,
  mode: AgentLaunchMode
): void {
  if (intent.reuseTerminal || intent.target.kind === 'create-worktree') {
    const options = mode === 'terminal' ? terminalLaunchOptions(intent) : intent.sessionOptions
    const preferences = toAgentLaunchPreferences(options, intent.agent)
    assertOpenCodeModelLaunchPreferencesAbsent(intent.agent, preferences)
  }
}

/** What every route that builds a terminal agent passes on, so the startup terminal of a new
 *  workspace and the terminal of an existing one start the same agent. */
export function terminalLaunchInputs(intent: AgentLaunchIntent) {
  return {
    // Projected for this agent by each terminal builder, which keeps only what has a flag.
    options: terminalLaunchOptions(intent),
    // `null` is a value the caller meant, so this tests for absence rather than falsiness.
    ...(intent.agentArgs !== undefined ? { agentArgs: intent.agentArgs } : {}),
    ...(intent.cwd ? { cwd: intent.cwd } : {}),
    ...(intent.launchSource ? { launchSource: intent.launchSource } : {}),
    ...(intent.paneKey ? { paneKey: intent.paneKey } : {}),
    ...(intent.accountEnv ? { accountEnv: intent.accountEnv } : {})
  }
}
