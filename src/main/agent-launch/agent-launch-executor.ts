/**
 * The one place an agent is actually started.
 *
 * Every launch surface routes through here: an orchestration dispatch, a mobile create, a CLI
 * create, and (once the renderer stops deciding for itself) a desktop agent tab. What those
 * surfaces duplicated was never the decision — that already lived in `agent-launch-mode` — but the
 * *sequencing* around it, and the sequencing is where the bug was:
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
  AgentLaunchResult,
  AgentLaunchTarget
} from '../../shared/agent-launch-intent'
import { withoutReservedAgentCreateFields } from '../../shared/agent-launch-intent'
import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
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
  }): Promise<{ sessionId: string; handle: string }>
  createTerminalAgent(args: {
    worktreeId: string
    agent: TuiAgent
    options?: Readonly<Record<string, unknown>>
  }): Promise<{ handle: string; warning?: string }>
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
  }): Promise<{ worktreeId: string; startupTerminalHandle: string | undefined }>
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
      ...promptReceipt(intent)
    }
  }

  const placed = await resolveWorkspace(execution, preflight)
  // Agent-first creation already produced the agent, so the pre-flight verdict is final.
  if (placed.startupTerminalHandle) {
    return {
      outcome: { kind: 'terminal', handle: placed.startupTerminalHandle },
      worktreeId: placed.worktreeId,
      receipt: preflight,
      ...promptReceipt(intent)
    }
  }

  execution.onStage?.('mode_settle')
  const settled = await resolveAgentLaunchModeOnHost(
    runtime,
    preflight,
    placed.worktreeId,
    intent.agent,
    vocabulary
  )

  execution.onStage?.('surface_create')
  const outcome = await createSurface(execution, placed.worktreeId, settled)
  return {
    outcome,
    worktreeId: placed.worktreeId,
    receipt: settled,
    ...promptReceipt(intent)
  }
}

async function resolveWorkspace(
  execution: AgentLaunchExecution,
  preflight: AgentLaunchModeReceipt
): Promise<{ worktreeId: string; startupTerminalHandle: string | undefined }> {
  const { intent } = execution
  if (intent.target.kind === 'existing') {
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

async function createSurface(
  execution: AgentLaunchExecution,
  worktreeId: string,
  settled: AgentLaunchModeReceipt
): Promise<AgentLaunchResult['outcome']> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured' && isStructuredProvider(intent.agent)) {
    const session = await surfaces.createStructuredSession({
      worktreeId,
      agent: intent.agent,
      ...(intent.sessionOptions ? { options: intent.sessionOptions } : {})
    })
    return { kind: 'structured', sessionId: session.sessionId, handle: session.handle }
  }
  const terminal = await surfaces.createTerminalAgent({
    worktreeId,
    agent: intent.agent,
    ...(intent.sessionOptions ? { options: intent.sessionOptions } : {})
  })
  return {
    kind: 'terminal',
    handle: terminal.handle,
    ...(terminal.warning ? { warning: terminal.warning } : {})
  }
}

function isStructuredProvider(agent: TuiAgent): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

function existingWorktreeId(target: AgentLaunchTarget): string {
  return target.kind === 'existing' ? target.worktree : ''
}

/** Prompt delivery is the caller's, not the executor's: a PTY paste is observed by whoever owns
 *  the pane, and a structured first turn is sent through the session. The executor reports the
 *  requested delivery back undelivered so a caller cannot mistake silence for delivery. */
function promptReceipt(intent: AgentLaunchIntent): Pick<AgentLaunchResult, 'prompt'> {
  if (!intent.prompt) {
    return {}
  }
  return { prompt: { delivery: intent.prompt.delivery, delivered: false } }
}
