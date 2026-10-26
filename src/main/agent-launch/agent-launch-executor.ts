/** Ask after workspace creation: the host needs resolved metadata to decide chat support. */

import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'
import { assertAgentPromptRequestActive } from '../runtime/orca-runtime-core'
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
  // Intent preparation may have outlived the request.
  assertAgentPromptRequestActive(execution.signal)
  if (execution.promptPolicy === 'legacy-host') {
    assertLegacyHostTarget(execution)
    const placed = await resolveWorkspace(execution, preflight)
    return published(execution, legacyHostCreateResult(execution, placed, preflight))
  }

  // A reused process cannot accept new argv; deliver through its PTY.
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

    // Recover a created workspace on cancellation before an agent exists.
    recoverableWorktreeId = execution.signal?.aborted ? placed.worktreeId : undefined
    assertAgentPromptRequestActive(execution.signal)
    const settlement: AgentLaunchModeSettlement = {
      phase: intent.target.kind === 'existing' ? 'before-effects' : 'created-workspace',
      agent: intent.agent,
      workspacePath: placed.workspacePath,
      cwd: intent.cwd
    }
    execution.onStage?.('mode_settle')
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
    assertAgentPromptRequestActive(execution.signal)
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
      // Cancellation must prevent a fallback from starting a new agent and argv prompt.
      assertAgentPromptRequestActive(execution.signal)
      settled = downgradeAgentLaunchModeForStructuredRefusal(settled, vocabulary, settlement)
      created = await createTerminalSurface(execution, placed)
    }
    // Create warnings are untyped strings, so startup-failure warnings may remain stale after recovery.
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
    // Reserved fields must come from the launch intent, not a stale create payload.
    create: withoutReservedAgentCreateFields(intent.target.create),
    ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
    ...(preflight.mode === 'structured' ? { promisedAgentChat: true } : {}),
    startupAgent: preflight.mode === 'structured' ? undefined : intent.agent,
    ...createLaunchPromptInputs(execution, preflight.mode),
    ...(preflight.mode === 'structured' ? {} : terminalLaunchInputs(intent))
  })
  // Without a startup terminal, no command carried the prompt; delivery is still owed.
  const { promptRodeLaunchCommand, ...rest } = created
  return rest.startupTerminalHandle && promptRodeLaunchCommand
    ? { ...rest, promptRodeLaunchCommand: true }
    : rest
}

/** Keep the structured surface’s creation fence for prompt delivery. */
export type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  structured?: AgentLaunchStructuredSurface
  promptRodeLaunchCommand?: boolean
}

async function createSurface(
  execution: AgentLaunchSurfaceExecution,
  workspace: { worktreeId: string; connectionId?: string | null },
  settled: AgentLaunchModeReceipt
): Promise<CreatedSurface> {
  const { intent, surfaces } = execution
  if (settled.mode === 'structured') {
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
