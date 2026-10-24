import type { AgentLaunchIntent, AgentLaunchPrompt } from '../../shared/agent-launch-intent'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { TuiAgent } from '../../shared/tui-agent'

/** Inject creation so orchestration can add subscriptions without duplicating launch sequencing. */
export type AgentLaunchSurfaceFactory = {
  createStructuredSession(args: {
    worktreeId: string
    agent: StructuredAgentId
    options?: Readonly<Record<string, unknown>>
    /** Caller-minted ID; reject with AgentLaunchSessionAlreadyExistsError if taken. */
    sessionId?: string
    /** Caller-reserved tab ID; omit to use the ID clients derive. */
    tabId?: string
    /** Keep chat idle until the caller submits its first message. */
    withoutPrompt?: true
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
    promptRodeLaunchCommand?: boolean
  }>
  /** Return the committed message ID, or null on failure; failed delivery must not fail a running launch. */
  deliverStructuredPrompt?(args: {
    sessionId: string
    fence: number
    prompt: AgentLaunchPrompt
  }): Promise<string | null>
  /** Paste into a live PTY; return false on failure without failing the running launch. */
  deliverTerminalPrompt?(args: {
    handle: string
    agent: TuiAgent
    /** Reused terminals have no fresh launch readiness signal to await. */
    freshLaunch: boolean
    prompt: AgentLaunchPrompt
    /** Abort readiness waits and refuse pending pastes. */
    signal?: AbortSignal
  }): Promise<boolean>
}

/** Carry the creation lease fence into the prompt envelope without rereading the session. */
export type AgentLaunchStructuredSurface = {
  sessionId: string
  handle: string
  fence: number
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

export function terminalLaunchInputs(intent: AgentLaunchIntent) {
  return {
    ...(intent.sessionOptions ? { options: intent.sessionOptions } : {}),
    // Null explicitly suppresses default arguments.
    ...(intent.agentArgs !== undefined ? { agentArgs: intent.agentArgs } : {}),
    ...(intent.cwd ? { cwd: intent.cwd } : {}),
    ...(intent.launchSource ? { launchSource: intent.launchSource } : {}),
    ...(intent.paneKey ? { paneKey: intent.paneKey } : {}),
    ...(intent.accountEnv ? { accountEnv: intent.accountEnv } : {})
  }
}
