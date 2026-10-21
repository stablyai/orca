/** Structured launches create the workspace without an agent, then ask its host for chat support.
 * The host needs the created workspace to answer; a definitive refusal starts a terminal agent. */

import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import { withoutReservedAgentCreateFields } from '../../shared/agent-launch-intent'
import {
  combineLaunchWarnings,
  ignoredStructuredLaunchInputsWarning
} from './agent-launch-warnings'
import {
  argvLaunchPrompt,
  deliverTerminalLaunchPrompt,
  HANDED_TO_TERMINAL,
  promptReceipt,
  settledAtCreation,
  settleLaunchPromptDisposal
} from './agent-launch-prompt-delivery'
import { workspaceKindForLaunchTarget } from '../../shared/workspace-launch-kind'
import { isDefinitiveAgentSessionCreateRefusal } from '../../shared/agent-session-definitive-refusal'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings,
  resolveAgentLaunchModeOnHost,
  type AgentLaunchModeReceipt,
  type AgentLaunchModeSettlement,
  DEFAULT_LAUNCH_VOCABULARY,
  downgradeAgentLaunchModeForStructuredRefusal,
  warnStructuredLaunchDowngrade
} from './agent-launch-mode'
import {
  assertLegacyHostTarget,
  createLaunchPromptInputs,
  legacyHostCreateResult
} from './agent-launch-legacy-host'
import {
  AgentLaunchStructuredSessionRefusedError,
  terminalLaunchInputs,
  type AgentLaunchStructuredSurface,
  type AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'
import type {
  AgentLaunchExecution,
  AgentLaunchPublishedSurface,
  AgentLaunchSurfaceExecution
} from './agent-launch-execution'
import {
  beginCreatedWorkspaceLaunch,
  recoverCreatedWorkspace
} from './agent-launch-created-workspace'

export type { AgentLaunchExecution, AgentLaunchPublishedSurface } from './agent-launch-execution'

export async function executeAgentLaunch(
  execution: AgentLaunchExecution
): Promise<AgentLaunchResult> {
  const { intent, runtime } = execution
  if (intent.reuseTerminal || intent.target.kind === 'create-worktree') {
    assertOpenCodeModelLaunchPreferencesAbsent(intent.agent, intent.sessionOptions)
  }
  const vocabulary = execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  const preflight =
    execution.decidedMode ??
    decideAgentLaunchMode({
      placement: {
        agent: intent.agent,
        workspaceKind: workspaceKindForLaunchTarget(intent.target),
        ...(intent.reuseTerminal ? { terminal: intent.reuseTerminal.handle } : {}),
        ...(intent.cwd ? { cwd: intent.cwd } : {}),
        ...(intent.target.kind === 'existing' && intent.target.workspacePath
          ? { workspacePath: intent.target.workspacePath }
          : {}),
        ...(execution.callerRendersStructured === false ? { callerRendersStructured: false } : {})
      },
      settings: execution.terminalOnly
        ? undefined
        : readAgentLaunchModeSettings(runtime, intent.nativeChatDefault),
      ...(execution.terminalOnly ? { terminalOnly: true } : {}),
      ...(intent.surface ? { surface: intent.surface } : {}),
      vocabulary
    })
  // The create's startup terminal is this launch's only surface, and the create delivers the text.
  if (execution.promptPolicy === 'legacy-host') {
    assertLegacyHostTarget(execution)
    const placed = await resolveWorkspace(execution, preflight)
    return published(execution, legacyHostCreateResult(execution, placed, preflight))
  }

  // A reused terminal already downgraded in the pre-flight; there is nothing to create. Its agent
  // was running before this launch existed, so argv is unreachable and the PTY is the only way in.
  if (intent.reuseTerminal) {
    const reused = published(execution, {
      outcome: { kind: 'terminal', handle: intent.reuseTerminal.handle },
      worktreeId: intent.target.kind === 'existing' ? intent.target.worktree : '',
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

  const launch =
    intent.target.kind === 'create-worktree' && preflight.mode === 'structured'
      ? beginCreatedWorkspaceLaunch(runtime, intent.agent)
      : undefined
  let placed: Awaited<ReturnType<typeof resolveWorkspace>> | undefined
  let surfacePublished = false
  let recoverableWorktreeId: string | undefined
  try {
    placed = await resolveWorkspace(execution, preflight, launch?.onWorkspaceCreated)
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
      surfacePublished = true
      launch?.release()
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

    const settlement: AgentLaunchModeSettlement = {
      phase: intent.target.kind === 'existing' ? 'before-effects' : 'created-workspace',
      agent: intent.agent,
      workspacePath: placed.workspacePath,
      cwd: intent.cwd
    }
    execution.onStage?.('mode_settle')
    // A caller's own decision about an existing workspace already carries that host's answer.
    let settled =
      execution.decidedMode && intent.target.kind === 'existing'
        ? preflight
        : await resolveAgentLaunchModeOnHost(
            runtime,
            preflight,
            placed.worktreeId,
            intent.agent,
            vocabulary,
            settlement
          )

    execution.onStage?.('surface_create')
    recoverableWorktreeId = placed.worktreeId
    let created: CreatedSurface
    try {
      created = await createSurface(execution, placed, settled)
    } catch (error) {
      if (
        settled.mode !== 'structured' ||
        !(error instanceof AgentLaunchStructuredSessionRefusedError) ||
        !isDefinitiveAgentSessionCreateRefusal(error.code)
      ) {
        throw error
      }
      settled = downgradeAgentLaunchModeForStructuredRefusal(settled, vocabulary, settlement)
      created = await createTerminalSurface(execution, placed)
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
    const surface = published(execution, {
      outcome: created.outcome,
      worktreeId: placed.worktreeId,
      receipt: settled,
      ...(warning ? { warning } : {}),
      ...promptReceipt(intent, settledAtCreation(intent, created))
    })
    surfacePublished = true
    launch?.release()
    return {
      ...surface,
      ...promptReceipt(intent, await settleLaunchPromptDisposal(execution, created))
    }
  } catch (error) {
    const createdWorktreeId = recoverableWorktreeId ?? launch?.createdWorktreeId()
    if (!surfacePublished && intent.target.kind !== 'existing' && createdWorktreeId) {
      await recoverCreatedWorkspace(execution.workspaces, createdWorktreeId)
    }
    throw error
  } finally {
    launch?.release()
  }
}

function published(
  execution: AgentLaunchExecution,
  surface: AgentLaunchPublishedSurface
): AgentLaunchPublishedSurface {
  warnStructuredLaunchDowngrade(execution.intent.agent, surface.receipt)
  execution.onSurfacePublished?.(surface)
  return surface
}

async function resolveWorkspace(
  execution: AgentLaunchExecution,
  preflight: AgentLaunchModeReceipt,
  onWorkspaceCreated?: (worktreeId: string) => void
): Promise<Awaited<ReturnType<AgentLaunchWorkspaceFactory['createWorktree']>>> {
  const { intent } = execution
  if (intent.target.kind === 'existing') {
    // Nothing was created, so there is no create warning to carry.
    const { worktree: worktreeId, connectionId, workspacePath } = intent.target
    return { worktreeId, connectionId, workspacePath, startupTerminalHandle: undefined }
  }
  const workspaces = execution.workspaces
  if (!workspaces) {
    throw new Error('agent_launch_workspace_factory_required')
  }
  execution.onStage?.('worktree_create')
  if (intent.target.kind === 'create-folder-workspace') {
    if (!workspaces.createFolderWorkspace) {
      throw new Error('agent_launch_workspace_factory_required')
    }
    const created = await workspaces.createFolderWorkspace({ create: intent.target.create })
    return { ...created, startupTerminalHandle: undefined }
  }
  const created = await workspaces.createWorktree({
    // A caller migrating from `worktree.create` passes its existing params; a stale `startupAgent`
    // in there would re-create the agent-first path this executor exists to replace. The launch
    // owns the prompt for the same reason, so it re-supplies its own rather than honouring theirs.
    create: withoutReservedAgentCreateFields(intent.target.create),
    ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
    ...(preflight.mode === 'structured' ? { promisedAgentChat: true } : {}),
    startupAgent: preflight.mode === 'structured' ? undefined : intent.agent,
    ...createLaunchPromptInputs(execution, preflight.mode),
    ...(preflight.mode === 'structured' ? {} : terminalLaunchInputs(intent))
  })
  // Only when a startup terminal actually came back: a create that produced none ran no command,
  // so nothing carried the prompt and the launch still owes it to whatever surface it builds next.
  const { promptRodeLaunchCommand, ...rest } = created
  return rest.startupTerminalHandle && promptRodeLaunchCommand
    ? { ...rest, promptRodeLaunchCommand: true }
    : rest
}

/** `structured` is the same surface `outcome` names, kept typed so prompt delivery reads the create's
 *  own fence rather than branching on `outcome.kind` and re-deriving it. */
export type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  structured?: AgentLaunchStructuredSurface
  /** True when this create folded the prompt into the agent's launch command. */
  promptRodeLaunchCommand?: boolean
}

async function createSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: { worktreeId: string; connectionId?: string | null },
  settled: AgentLaunchModeReceipt
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured') {
    // One reservation serves either route: the tab half of the reserved pane is the chat's tab.
    const reservedTabId = intent.paneKey ? parsePaneKey(intent.paneKey)?.tabId : undefined
    const session = await surfaces.createStructuredSession({
      worktreeId: workspace.worktreeId,
      agent: intent.agent,
      ...(intent.sessionOptions ? { options: intent.sessionOptions } : {}),
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(reservedTabId ? { tabId: reservedTabId } : {}),
      ...(intent.prompt ? {} : { withoutPrompt: true as const })
    })
    return {
      outcome: {
        kind: 'structured',
        sessionId: session.sessionId,
        handle: session.handle,
        ...(session.tabId ? { tabId: session.tabId } : {})
      },
      structured: session,
      ...ignoredStructuredLaunchInputsWarning(intent)
    }
  }
  return createTerminalSurface(execution, workspace)
}

/**
 * The one place a terminal agent is created, so the structured-refusal downgrade builds the same
 * surface — carrying the same argv prompt — as a launch that chose a terminal outright.
 */
async function createTerminalSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: { worktreeId: string; connectionId?: string | null }
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  const startupPrompt = argvLaunchPrompt(intent)
  const terminal = await surfaces.createTerminalAgent({
    worktreeId: workspace.worktreeId,
    agent: intent.agent,
    ...(startupPrompt ? { startupPrompt } : {}),
    ...terminalLaunchInputs(intent),
    viewMode: 'terminal'
  })
  return {
    outcome: {
      kind: 'terminal',
      handle: terminal.handle,
      ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {})
    },
    ...(terminal.warning ? { warning: terminal.warning } : {}),
    ...(startupPrompt && terminal.promptRodeLaunchCommand ? { promptRodeLaunchCommand: true } : {})
  }
}
