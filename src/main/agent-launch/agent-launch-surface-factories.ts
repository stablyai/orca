import type { HostFoundingAttempt } from './host-founding-attempt'
/**
 * The factories `executeAgentLaunch` is handed: how a surface and a workspace are BUILT once the
 * executor has decided which. Separate from the executor because they are the contract each caller
 * implements, not part of the sequencing it runs.
 */

import type {
  AgentLaunchIntent,
  AgentLaunchPrompt,
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../shared/agent-launch-intent'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { StructuredAgentSessionFirstMessage } from '../../shared/structured-agent-session-create'

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
    hostFoundingAttempt?: HostFoundingAttempt
    firstMessage?: StructuredAgentSessionFirstMessage['body']
  }): Promise<AgentLaunchStructuredSurface>
  createTerminalAgent(args: {
    worktreeId: string
    sequenceTerminalCommand?: AgentLaunchTerminalSequence
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
  /**
   * Writes the launch text into a terminal agent's live PTY, answering whether it landed.
   *
   * The other half of `startupPrompt`, for the cases the launch command cannot serve: a
   * `stdin-after-start` agent, whose CLI takes no prompt argument; a prompt the typed line cannot
   * carry; and a reused terminal, whose process was already running before this launch existed. `false` for every failure, on the same rule the structured
   * twin follows — a launch whose agent is running must not fail because its text did not land.
   */
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

export type AgentLaunchStructuredSurface = {
  sessionId: string
  handle: string
  fence: number
  /** Older hosts may omit the host-owned tab ID. */
  tabId?: string
  promptDisposal?: AgentLaunchPromptDisposal
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

export type AgentLaunchTerminalSequence = (command: string) => {
  command: string
  env?: Record<string, string>
}

export type AgentLaunchWorkspace = {
  sequenceTerminalCommand?: AgentLaunchTerminalSequence
  worktreeId: string
  workspacePath?: string
  connectionId?: string | null
  startupTerminalHandle: string | undefined
  startupTerminalPaneKey?: string
  warning?: string
  promptRodeLaunchCommand?: boolean
  created?: CreateWorktreeResult
}

export type AgentLaunchInitialSurfaceStage = (
  workspace: AgentLaunchWorkspace
) => Promise<Pick<AgentLaunchResult, 'outcome'> | void>

/** Creating the workspace, when the intent asks for one. Injected so orchestration keeps recording
 *  its own worktree stages and residual-resource effects around the same call. */
export type AgentLaunchWorkspaceFactory = {
  createWorktree(args: {
    create: Readonly<Record<string, unknown>>
    /** Register before announcing the workspace. */
    onWorkspaceCreated?: (worktreeId: string) => void
    promisedAgentChat?: boolean
    initializeSurface?: AgentLaunchInitialSurfaceStage
    /** Set only when the settled mode is a terminal agent: agent-first creation sequences the
     *  agent's startup command behind the setup runner, which is how a PTY launch gets its
     *  wait-for-setup gate. Chats are committed independently of setup. */
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
  }): Promise<AgentLaunchWorkspace>

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
