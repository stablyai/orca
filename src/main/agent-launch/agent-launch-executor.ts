/**
 * The one place an agent is actually started — for the surfaces moved onto it, which today is
 * `agent.launch` alone. Orchestration dispatch, mobile create, CLI create and the desktop agent
 * tab each still start agents their own way; moving them here is later stack work.
 *
 * The mode decision is shared, not copied: `agent-launch-mode` owns it, and
 * `orchestration-worker-start-mode` is a thin adapter over it supplying orchestration's receipt
 * vocabulary. What this module adds is the *sequencing*, and the sequencing is where the bug
 * was:
 *
 *   create the worktree agent-first  ->  its startup terminal IS the agent
 *                                    ->  the structured branch below it is unreachable
 *
 * so every new-worktree launch was a PTY no matter what the user's default said. The order here is
 * the inverse, and it is the whole point of the module: when the preference is structured the
 * worktree is created with NO startup agent, the executing host is then asked whether it can host
 * a session for the workspace that now exists, and only then is a surface created. A refusal
 * becomes a terminal agent in the worktree just created, never a failed launch.
 *
 * The host verdict cannot be hoisted above creation: `agentSession.createSupport` can only answer
 * for a workspace it can resolve. That is why the decision is in two halves rather than one.
 *
 * What genuinely differs per surface is only how a surface is *built* — an orchestration worker's
 * session takes a dispatch hold and a mailbox that a plain launch must not take — so that is
 * injected as a factory instead of branched on here.
 */

import type {
  AgentLaunchIntent,
  AgentLaunchPrompt,
  AgentLaunchResult,
  AgentLaunchTarget
} from '../../shared/agent-launch-intent'
import { withoutReservedAgentCreateFields } from '../../shared/agent-launch-intent'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  workspaceKindForWorktreeId,
  type WorkspaceLaunchKind
} from '../../shared/workspace-launch-kind'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isDefinitiveAgentSessionCreateRefusal } from '../../shared/agent-session-definitive-refusal'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings,
  resolveAgentLaunchModeOnHost,
  type AgentLaunchModeReceipt,
  type AgentLaunchModeVocabulary,
  DEFAULT_LAUNCH_VOCABULARY
} from './agent-launch-mode'

/** How a surface is built once the executor has decided which one. Injected because an
 *  orchestration worker's session carries a dispatch hold and a mailbox a plain launch must not
 *  take, while the decision and ordering above it are identical. */
export type AgentLaunchSurfaceFactory = {
  createStructuredSession(args: {
    worktreeId: string
    agent: 'claude' | 'codex'
    options?: Readonly<Record<string, unknown>>
  }): Promise<AgentLaunchStructuredSurface>
  createTerminalAgent(args: {
    worktreeId: string
    agent: TuiAgent
    options?: Readonly<Record<string, unknown>>
  }): Promise<{ handle: string; warning?: string }>
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
}

/** `fence` is carried out of the create because a send must name the lease it was admitted against,
 *  and re-reading it later would read whatever fence the session has by then. */
export type AgentLaunchStructuredSurface = {
  sessionId: string
  handle: string
  fence: number
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
    create: Readonly<Record<string, unknown>>
    /** Set only when the settled mode is a terminal agent: agent-first creation sequences the
     *  agent's startup command behind the setup runner, which is how a PTY launch gets its
     *  wait-for-setup gate for free. A structured launch has no startup command to sequence and
     *  must await that gate explicitly instead. */
    startupAgent: TuiAgent | undefined
  }): Promise<{
    worktreeId: string
    startupTerminalHandle: string | undefined
    /** Created, but incomplete — surfaced on the launch result rather than dropped. */
    warning?: string
  }>
}

export type AgentLaunchExecution = {
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport' | 'getClientSettings'>
  intent: AgentLaunchIntent
  surfaces: AgentLaunchSurfaceFactory
  workspaces?: AgentLaunchWorkspaceFactory
  vocabulary?: AgentLaunchModeVocabulary
  /** Attributes a throw to the step that was running, the way a dispatch's own stages do. */
  onStage?: (stage: 'worktree_create' | 'mode_settle' | 'surface_create') => void
}

export async function executeAgentLaunch(
  execution: AgentLaunchExecution
): Promise<AgentLaunchResult> {
  const { intent, runtime } = execution
  const vocabulary = execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  const settings = readAgentLaunchModeSettings(runtime)
  const preflight = decideAgentLaunchMode({
    placement: {
      agent: intent.agent,
      workspaceKind: launchWorkspaceKind(intent.target),
      ...(intent.reuseTerminal ? { terminal: intent.reuseTerminal.handle } : {})
    },
    settings,
    vocabulary
  })

  // A reused terminal already downgraded in the pre-flight; there is nothing to create.
  if (intent.reuseTerminal) {
    return {
      outcome: { kind: 'terminal', handle: intent.reuseTerminal.handle },
      worktreeId: existingWorktreeId(intent.target),
      receipt: preflight,
      ...promptReceipt(intent, null)
    }
  }

  const placed = await resolveWorkspace(execution, preflight)
  // Agent-first creation already produced the agent, so the pre-flight verdict is final.
  if (placed.startupTerminalHandle) {
    return {
      outcome: { kind: 'terminal', handle: placed.startupTerminalHandle },
      worktreeId: placed.worktreeId,
      receipt: preflight,
      ...(placed.warning ? { warning: placed.warning } : {}),
      ...promptReceipt(intent, null)
    }
  }

  execution.onStage?.('mode_settle')
  let settled = await resolveAgentLaunchModeOnHost(
    runtime,
    preflight,
    placed.worktreeId,
    intent.agent,
    vocabulary
  )

  execution.onStage?.('surface_create')
  let created: CreatedSurface
  try {
    created = await createSurface(execution, placed.worktreeId, settled)
  } catch (error) {
    // The structured create path distinguishes a definitive pre-commit refusal from an unknown
    // outcome. Only the former is safe to replace with a terminal in the same workspace; retrying
    // after an unknown attach outcome could create two agents.
    if (
      settled.mode !== 'structured' ||
      !(error instanceof AgentLaunchStructuredSessionRefusedError) ||
      !isDefinitiveAgentSessionCreateRefusal(error.code)
    ) {
      throw error
    }
    settled = downgradeAgentLaunchModeForStructuredRefusal(settled, vocabulary)
    created = await execution.surfaces
      .createTerminalAgent({
        worktreeId: placed.worktreeId,
        agent: intent.agent,
        ...(intent.sessionOptions ? { options: intent.sessionOptions } : {})
      })
      .then((terminal) => ({
        outcome: { kind: 'terminal' as const, handle: terminal.handle },
        ...(terminal.warning ? { warning: terminal.warning } : {})
      }))
  }
  // Both CAN be set, so neither may be dropped. The create warns precisely when it produced no
  // startup terminal — `didSpawnStartup` stays false when that spawn throws — and that is the same
  // condition which skips the early return above, so the launch goes on to build a second surface,
  // and that one can warn too. The other path is an untracked-copy warning followed by a structured
  // refusal downgrading to a terminal that warns. `??` kept the first and lost the second silently.
  //
  // KNOWN GAP, deliberately not fixed here: a create warning about a FAILED startup terminal is
  // stale once the launch recovers by building a working one, so the user can be told the agent did
  // not start while looking at it. Telling those apart needs `createManagedWorktree` to stop
  // multiplexing "couldn't copy untracked files" and "startup terminal failed" into one string.
  const warning = combineLaunchWarnings(placed.warning, created.warning)
  return {
    outcome: created.outcome,
    worktreeId: placed.worktreeId,
    receipt: settled,
    ...(warning ? { warning } : {}),
    ...promptReceipt(intent, await deliverLaunchPrompt(execution, created.structured))
  }
}

/**
 * Hands the launch text to the surface that can commit it, which is a structured session and only
 * a structured session: a terminal's paste is observed by whoever owns the pane, and a `draft` has
 * no host-side home — the composer holds one, and the host has no composer.
 */
async function deliverLaunchPrompt(
  execution: AgentLaunchExecution,
  structured: AgentLaunchStructuredSurface | undefined
): Promise<string | null> {
  const { intent, surfaces } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit' || !structured) {
    return null
  }
  return (
    (await surfaces.deliverStructuredPrompt?.({
      sessionId: structured.sessionId,
      fence: structured.fence,
      prompt: intent.prompt
    })) ?? null
  )
}

function downgradeAgentLaunchModeForStructuredRefusal(
  receipt: AgentLaunchModeReceipt,
  vocabulary: AgentLaunchModeVocabulary
): AgentLaunchModeReceipt {
  return {
    mode: 'terminal',
    preferred: receipt.preferred,
    reason: 'structured_unsupported_on_host',
    detail: `Your default is a structured chat session, but the host refused to create one here; started ${vocabulary.terminal} instead.`
  }
}

async function resolveWorkspace(
  execution: AgentLaunchExecution,
  preflight: AgentLaunchModeReceipt
): Promise<{
  worktreeId: string
  startupTerminalHandle: string | undefined
  warning?: string
}> {
  const { intent } = execution
  if (intent.target.kind === 'existing') {
    // Nothing was created, so there is no create warning to carry.
    return { worktreeId: intent.target.worktree, startupTerminalHandle: undefined }
  }
  const workspaces = execution.workspaces
  if (!workspaces) {
    throw new Error('agent_launch_workspace_factory_required')
  }
  execution.onStage?.('worktree_create')
  return workspaces.createWorktree({
    // A caller migrating from `worktree.create` passes its existing params; a stale `startupAgent`
    // in there would re-create the agent-first path this executor exists to replace.
    create: withoutReservedAgentCreateFields(intent.target.create),
    startupAgent: preflight.mode === 'structured' ? undefined : intent.agent
  })
}

/** `structured` is the same surface `outcome` names, kept typed so prompt delivery reads the create's
 *  own fence rather than branching on `outcome.kind` and re-deriving it. */
type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  structured?: AgentLaunchStructuredSurface
}

async function createSurface(
  execution: AgentLaunchExecution,
  worktreeId: string,
  settled: AgentLaunchModeReceipt
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured' && isStructuredProvider(intent.agent)) {
    const session = await surfaces.createStructuredSession({
      worktreeId,
      agent: intent.agent,
      ...(intent.sessionOptions ? { options: intent.sessionOptions } : {})
    })
    return {
      outcome: { kind: 'structured', sessionId: session.sessionId, handle: session.handle },
      structured: session
    }
  }
  const terminal = await surfaces.createTerminalAgent({
    worktreeId,
    agent: intent.agent,
    ...(intent.sessionOptions ? { options: intent.sessionOptions } : {})
  })
  return {
    outcome: { kind: 'terminal', handle: terminal.handle },
    ...(terminal.warning ? { warning: terminal.warning } : {})
  }
}

/**
 * Two warnings, both true, neither droppable.
 *
 * Mirrors how the create combines its own failures — `appendFailure` in
 * runtime-local-worktree-terminal-startup.ts, and the startup-terminal catch in
 * runtime-remote-managed-worktree-create.ts — which append rather than replace.
 */
function combineLaunchWarnings(
  create: string | undefined,
  surface: string | undefined
): string | undefined {
  if (!create || !surface) {
    return create ?? surface
  }
  return `${create} Also ${surface[0].toLowerCase()}${surface.slice(1)}`
}

function isStructuredProvider(agent: TuiAgent): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

function existingWorktreeId(target: AgentLaunchTarget): string {
  return target.kind === 'existing' ? target.worktree : ''
}

/**
 * Read from the id rather than carried alongside it, so the kind cannot disagree with the workspace
 * it describes. `worktree` here is never a caller's selector — the method resolved it to an id
 * before building the intent — and a create always produces a git worktree.
 */
function launchWorkspaceKind(target: AgentLaunchTarget): WorkspaceLaunchKind {
  return target.kind === 'existing' ? workspaceKindForWorktreeId(target.worktree) : 'git-worktree'
}

/**
 * The one place a disposal is constructed, so the three arms cannot drift apart.
 *
 * `journaled` is reachable only from a committed message id, and that id exists only because the
 * host appended the transcript row first — the receipt is a consequence of the commit, never a
 * write-ahead of it. Everything else under-claims as `not-delivered`, which costs a resend; there
 * is deliberately no arm for "maybe", because a caller holding one could neither resend nor drop
 * the text. Dispatch doubt is not this tier's to report: the submission row carries it.
 */
function promptReceipt(
  intent: AgentLaunchIntent,
  messageId: string | null
): Pick<AgentLaunchResult, 'prompt'> {
  if (!intent.prompt) {
    return {}
  }
  const delivery = intent.prompt.delivery
  return {
    prompt: messageId
      ? { delivery, outcome: 'journaled', messageId }
      : { delivery, outcome: 'not-delivered' }
  }
}
