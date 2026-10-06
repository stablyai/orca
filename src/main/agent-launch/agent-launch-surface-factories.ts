/**
 * The factories `executeAgentLaunch` is handed: how a surface and a workspace are BUILT once the
 * executor has decided which. Separate from the executor because they are the contract each caller
 * implements, not part of the sequencing it runs.
 */

import type { AgentLaunchPrompt } from '../../shared/agent-launch-intent'
import type { TuiAgent } from '../../shared/tui-agent'

/** How a surface is built once the executor has decided which one. Injected because an
 *  orchestration worker's session carries a redrive subscription and a mailbox a plain launch
 *  must not take, while the decision and ordering above it are identical. */
export type AgentLaunchSurfaceFactory = {
  createStructuredSession(args: {
    worktreeId: string
    agent: 'claude' | 'codex'
    options?: Readonly<Record<string, unknown>>
    /** The caller-minted session id; refused with `AgentLaunchSessionAlreadyExistsError` if taken. */
    sessionId?: string
    /** The caller-reserved tab id (the tab half of `paneKey`), so the host records where this chat
     *  is shown; absent records the id clients derive. */
    tabId?: string
  }): Promise<AgentLaunchStructuredSurface>
  createTerminalAgent(args: {
    codexAccountId?: string | null
    worktreeId: string
    agent: TuiAgent
    options?: Readonly<Record<string, unknown>>
    /** Offered only for an agent whose CLI takes the prompt on argv. It rides the launch command
     *  only when the typed line can carry it; `promptRodeLaunchCommand` reports which happened. */
    startupPrompt?: string
    /** Replaces the settings default for this launch only; `null` means no arguments at all. */
    agentArgs?: string | null
    cwd?: string
    /** The one member of the `agent_started` triple the host cannot derive for itself. */
    launchSource?: string
    /** The caller-minted pane to create; refused with `AgentLaunchPaneAlreadyLiveError` if live. */
    paneKey?: string
  }): Promise<{
    handle: string
    /** The pane this create minted; a factory whose runtime reports none omits it, never invents. */
    paneKey?: string
    warning?: string
    /** Reported by the surface that built the typed line, never predicted by the executor. */
    promptRodeLaunchCommand?: boolean
  }>
  /**
   * Commits the launch text as the session's first turn, answering with the transcript row's id.
   *
   * `null` means nothing was committed, and is the answer for every failure — a refused send, an
   * unreachable host, a throw. Delivery must not fail a launch whose agent is already running: the
   * caller can resend under `not-delivered`, but it cannot un-create a workspace.
   */
  deliverStructuredPrompt?(args: {
    sessionId: string
    fence: number
    prompt: AgentLaunchPrompt
  }): Promise<string | null>
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
    /** The launched agent, whose own readiness signal the write waits for. */
    agent: TuiAgent
    /** False for a reused terminal, which has no fresh launch readiness to wait for. */
    freshLaunch: boolean
    prompt: AgentLaunchPrompt
  }): Promise<boolean>
}

/** `fence` is the lease the create was admitted at, carried so the launch prompt's send can fill its
 *  envelope without re-reading the session; the host does not check a write's fence. */
export type AgentLaunchStructuredSurface = {
  sessionId: string
  handle: string
  fence: number
  /** The host-owned id of the tab that shows this chat; a host that predates it reports none. */
  tabId?: string
}

/** A structured create refusal that proves no session was committed, so the launch may downgrade. */
export class AgentLaunchStructuredSessionRefusedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentLaunchStructuredSessionRefusedError'
    this.code = code
  }
}

/** Creating the workspace, when the intent asks for one. Injected so orchestration keeps recording
 *  its own worktree stages and residual-resource effects around the same call. */
export type AgentLaunchWorkspaceFactory = {
  createWorktree(args: {
    codexAccountId?: string | null
    create: Readonly<Record<string, unknown>>
    /** Set only when the settled mode is a terminal agent: agent-first creation sequences the
     *  agent's startup command behind the setup runner, which is how a PTY launch gets its
     *  wait-for-setup gate for free. A structured launch has no startup command to sequence and
     *  must await that gate explicitly instead. */
    startupAgent: TuiAgent | undefined
    /** Offered only alongside a `startupAgent` whose CLI takes the prompt on argv: agent-first
     *  creation builds the startup command, so that is where the typed line is measured. */
    startupPrompt?: string
    /** Inputs needed when this terminal is created as the worktree's startup surface. */
    agentArgs?: string | null
    cwd?: string
    launchSource?: string
    paneKey?: string
    /** The launch's session options, read as the startup terminal's model/effort/mode preferences. */
    options?: Readonly<Record<string, unknown>>
  }): Promise<{
    worktreeId: string
    startupTerminalHandle: string | undefined
    /** The pane minted with the startup terminal, when the runtime reported one. */
    startupTerminalPaneKey?: string
    /** Created, but incomplete — surfaced on the launch result rather than dropped. */
    warning?: string
    /** Reported by the create that built the startup command's typed line. */
    promptRodeLaunchCommand?: boolean
  }>
}
