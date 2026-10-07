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
 * session takes a redrive subscription and a mailbox that a plain launch must not take — so that
 * is injected as a factory instead of branched on here.
 */

import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'
import type {
  AgentLaunchIntent,
  AgentLaunchResult,
  AgentLaunchTarget
} from '../../shared/agent-launch-intent'
import { withoutReservedAgentCreateFields } from '../../shared/agent-launch-intent'
import {
  deliverTerminalLaunchPrompt,
  HANDED_TO_TERMINAL,
  launchCommandPrompt,
  promptReceipt,
  settledAtCreation,
  settleLaunchPromptDisposal
} from './agent-launch-prompt-delivery'
import { AgentLaunchTabClosedError } from '../../shared/agent-launch-tab-closed'
import { AgentLaunchWorkspaceKeptError } from '../../shared/agent-launch-agent-not-started'
import { AgentLaunchPaneAlreadyLiveError } from '../../shared/agent-launch-pane-already-live'
import { AgentLaunchSessionAlreadyExistsError } from '../../shared/agent-launch-session-already-exists'
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
import {
  createSurface,
  createTerminalSurface,
  terminalLaunchInputs,
  type CreatedSurface
} from './agent-launch-surface-create'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory,
  type AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'

export type AgentLaunchExecution = {
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport' | 'getClientSettings'>
  intent: AgentLaunchIntent
  surfaces: AgentLaunchSurfaceFactory
  workspaces?: AgentLaunchWorkspaceFactory
  vocabulary?: AgentLaunchModeVocabulary
  /** False when the calling client cannot show the agent's chat; absent for the host's own callers. */
  callerRendersStructured?: boolean
  /** Attributes a throw to the step that was running, the way a dispatch's own stages do. */
  onStage?: (stage: 'worktree_create' | 'mode_settle' | 'surface_create') => void
  /** The surface exists and its tab is published; runs before any prompt delivery. Must not throw. */
  onSurfacePublished?: (surface: AgentLaunchPublishedSurface) => void
}

/**
 * The launch as it stands once its surface exists: a complete result whose prompt receipt says only
 * what creation itself settled — carried on the launch command, a draft the host never delivers, or
 * a submit still `unconfirmed`. Complete so a host that dies during the delivery still leaves a
 * truthful answer behind.
 */
export type AgentLaunchPublishedSurface = AgentLaunchResult

export async function executeAgentLaunch(
  execution: AgentLaunchExecution
): Promise<AgentLaunchResult> {
  const { intent, runtime } = execution
  if (intent.reuseTerminal || intent.target.kind === 'create-worktree') {
    assertOpenCodeModelLaunchPreferencesAbsent(intent.agent, intent.sessionOptions)
  }
  const vocabulary = execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  const settings = readAgentLaunchModeSettings(runtime)
  const preflight = decideAgentLaunchMode({
    placement: {
      agent: intent.agent,
      workspaceKind: launchWorkspaceKind(intent.target),
      ...(intent.reuseTerminal ? { terminal: intent.reuseTerminal.handle } : {}),
      ...(intent.cwd ? { cwd: intent.cwd } : {}),
      ...(intent.target.kind === 'existing' && intent.target.workspacePath
        ? { workspacePath: intent.target.workspacePath }
        : {}),
      ...(execution.callerRendersStructured === false ? { callerRendersStructured: false } : {})
    },
    settings,
    vocabulary
  })

  // A reused terminal already downgraded in the pre-flight; there is nothing to create. Its agent
  // was running before this launch existed, so argv is unreachable and the PTY is the only way in.
  if (intent.reuseTerminal) {
    const reused = published(execution, {
      outcome: { kind: 'terminal', handle: intent.reuseTerminal.handle },
      worktreeId: existingWorktreeId(intent.target),
      receipt: preflight,
      ...promptReceipt(intent, settledAtCreation(intent, {}))
    })
    return {
      ...reused,
      ...promptReceipt(
        intent,
        await deliverTerminalLaunchPrompt(execution, intent.reuseTerminal.handle, {
          freshLaunch: false
        })
      )
    }
  }

  // The create may ask for the agent itself (its startup terminal). Once it has, no later failure
  // proves the agent never started, whatever happens to the surface built after it.
  let startupAgentRequested = false
  const placed = await resolveWorkspace(execution, preflight, () => {
    startupAgentRequested = true
  })
  // Agent-first creation already produced the agent, so the pre-flight verdict is final.
  if (placed.startupTerminalHandle) {
    const startup = published(execution, {
      outcome: {
        kind: 'terminal',
        handle: placed.startupTerminalHandle,
        ...(placed.startupTerminalPaneKey ? { paneKey: placed.startupTerminalPaneKey } : {})
      },
      worktreeId: placed.worktreeId,
      receipt: preflight,
      ...(placed.warning ? { warning: placed.warning } : {}),
      ...promptReceipt(intent, settledAtCreation(intent, placed))
    })
    return {
      ...startup,
      ...promptReceipt(
        intent,
        placed.promptRodeLaunchCommand
          ? HANDED_TO_TERMINAL
          : await deliverTerminalLaunchPrompt(execution, placed.startupTerminalHandle, {
              freshLaunch: true
            })
      )
    }
  }

  let agentRequested = false
  const { settled, created } = await keepWorkspaceWhenAgentNeverStarted(
    intent,
    placed,
    (error) =>
      !startupAgentRequested &&
      (!agentRequested || execution.surfaces.failedBeforeAgentStart?.(error) === true),
    async () => {
      execution.onStage?.('mode_settle')
      let settled = await resolveAgentLaunchModeOnHost(
        runtime,
        preflight,
        placed.worktreeId,
        intent.agent,
        vocabulary
      )

      execution.onStage?.('surface_create')
      agentRequested = true
      let created: CreatedSurface
      try {
        created = await createSurface(execution, placed, settled)
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
        created = await createTerminalSurface(execution, placed)
      }
      return { settled, created }
    }
  )
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
  const surface = published(execution, {
    outcome: created.outcome,
    worktreeId: placed.worktreeId,
    receipt: settled,
    ...(warning ? { warning } : {}),
    ...promptReceipt(intent, settledAtCreation(intent, created))
  })
  return {
    ...surface,
    ...promptReceipt(intent, await settleLaunchPromptDisposal(execution, created))
  }
}

function published(
  execution: AgentLaunchExecution,
  surface: AgentLaunchPublishedSurface
): AgentLaunchPublishedSurface {
  execution.onSurfacePublished?.(surface)
  return surface
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
  preflight: AgentLaunchModeReceipt,
  onStartupAgentRequested: () => void
): Promise<{
  worktreeId: string
  connectionId: string | null | undefined
  startupTerminalHandle: string | undefined
  startupTerminalPaneKey?: string
  warning?: string
  /** True when this create folded the prompt into the agent's startup command. */
  promptRodeLaunchCommand?: boolean
}> {
  const { intent } = execution
  if (intent.target.kind === 'existing') {
    // Nothing was created, so there is no create warning to carry.
    const { worktree: worktreeId, connectionId } = intent.target
    return { worktreeId, connectionId, startupTerminalHandle: undefined }
  }
  const workspaces = execution.workspaces
  if (!workspaces) {
    throw new Error('agent_launch_workspace_factory_required')
  }
  execution.onStage?.('worktree_create')
  const startupPrompt = launchCommandPrompt(intent, preflight.mode)
  const created = await workspaces.createWorktree({
    // A caller migrating from `worktree.create` passes its existing params; a stale `startupAgent`
    // in there would re-create the agent-first path this executor exists to replace. The launch
    // owns the prompt for the same reason, so it re-supplies its own rather than honouring theirs.
    create: withoutReservedAgentCreateFields(intent.target.create),
    startupAgent: preflight.mode === 'structured' ? undefined : intent.agent,
    ...(startupPrompt ? { startupPrompt } : {}),
    ...(preflight.mode === 'structured' ? {} : terminalLaunchInputs(intent)),
    onStartupAgentRequested
  })
  // Only when a startup terminal actually came back: a create that produced none ran no command,
  // so nothing carried the prompt and the launch still owes it to whatever surface it builds next.
  const { promptRodeLaunchCommand, ...rest } = created
  return rest.startupTerminalHandle && promptRodeLaunchCommand
    ? { ...rest, promptRodeLaunchCommand: true }
    : rest
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
 * A create whose workspace exists and whose agent provably never started keeps the workspace, and
 * says so instead of an unknown outcome. A failure after an agent was asked for proves nothing (a
 * spawn whose reply was lost may still be running), so it propagates as before; a tab the user
 * closed has its own answer. A live reserved pane or a taken reserved session in the workspace this
 * launch just made is most likely its own agent, so neither is ever "not started".
 */
async function keepWorkspaceWhenAgentNeverStarted<T>(
  intent: AgentLaunchIntent,
  placed: { worktreeId: string },
  neverStarted: (error: unknown) => boolean,
  start: () => Promise<T>
): Promise<T> {
  try {
    return await start()
  } catch (error) {
    if (
      intent.target.kind !== 'create-worktree' ||
      error instanceof AgentLaunchTabClosedError ||
      error instanceof AgentLaunchPaneAlreadyLiveError ||
      error instanceof AgentLaunchSessionAlreadyExistsError ||
      !neverStarted(error)
    ) {
      throw error
    }
    throw new AgentLaunchWorkspaceKeptError(placed.worktreeId, { cause: error })
  }
}
