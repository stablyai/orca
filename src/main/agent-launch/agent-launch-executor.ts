import { awaitRequiredSetup, AgentLaunchSetupNotCompletedError } from '../runtime/setup/setup-run'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
import { decideAgentLaunchIntentMode } from './agent-launch-intent-mode'
/** Structured launches create the workspace without an agent, then ask its host for chat support.
 * The host needs the created workspace to answer; a definitive refusal starts a terminal agent. */

import { assertAgentPromptRequestActive } from '../runtime/orca-runtime-core'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  type AgentLaunchResult,
  withoutReservedAgentCreateFields
} from '../../shared/agent-launch-intent'
import {
  combineLaunchWarnings,
  ignoredStructuredLaunchInputsWarning
} from './agent-launch-warnings'
import {
  launchPromptCreateInputs,
  deliverTerminalLaunchPrompt,
  HANDED_TO_TERMINAL,
  promptReceipt,
  settledAtCreation,
  settleLaunchPromptDisposal
} from './agent-launch-prompt-delivery'
import { isDefinitiveAgentSessionCreateRefusal } from '../../shared/agent-session/failures/agent-session-definitive-refusal'
import {
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
  assertTerminalLaunchAdmissible,
  terminalLaunchInputs,
  type AgentLaunchStructuredSurface,
  type AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'
import type { AgentLaunchExecution, AgentLaunchSurfaceExecution } from './agent-launch-execution'
import {
  beginCreatedWorkspaceLaunch,
  recoverCreatedWorkspace
} from './agent-launch-created-workspace'
import {
  acceptedTerminalIntent,
  assertAcceptedLaunchOpen,
  awaitAcceptedLaunchSetup
} from './agent-launch-acceptance'
import { createTerminalSurface } from './agent-launch-terminal-surface'

export type { AgentLaunchExecution, AgentLaunchPublishedSurface } from './agent-launch-execution'

export async function executeAgentLaunch(
  execution: AgentLaunchExecution
): Promise<AgentLaunchResult> {
  const { intent, runtime } = execution
  const vocabulary = execution.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  const preflight = execution.decidedMode ?? decideAgentLaunchIntentMode(execution)
  assertTerminalLaunchAdmissible(intent, preflight.mode)
  // A caller's own preparation (intent resolution) may have outlived its request.
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
                freshLaunch: true,
                terminalCreation: placed.startupTerminalCreation
              })
        )
      }
    }

    const acceptance = execution.acceptance
    if ((acceptance?.requiredSetup ?? placed.requiredSetup)?.waitsForAgent) {
      execution.onStage?.('setup_wait')
    }
    await (acceptance
      ? awaitAcceptedLaunchSetup(acceptance, intent.agent, execution.signal)
      : awaitRequiredSetup(placed.requiredSetup, intent.agent, execution.signal))

    // Recover a created workspace on cancellation before an agent exists.
    recoverableWorktreeId = execution.signal?.aborted ? placed.worktreeId : undefined
    assertAgentPromptRequestActive(execution.signal)
    // An accepted launch decides after Setup, as a created workspace does: a refusal starts its terminal.
    const settlement: AgentLaunchModeSettlement = {
      phase:
        intent.target.kind === 'existing' && !acceptance ? 'before-effects' : 'created-workspace',
      agent: intent.agent,
      workspacePath: placed.workspacePath,
      cwd: intent.cwd
    }
    execution.onStage?.('mode_settle')
    let settled =
      execution.decidedMode && intent.target.kind === 'existing' && !acceptance
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
    assertAcceptedLaunchOpen(acceptance)
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
      assertAcceptedLaunchOpen(acceptance)
      settled = downgradeAgentLaunchModeForStructuredRefusal(settled, vocabulary, settlement)
      created = await createTerminalSurface(execution, placed)
    }
    // Create warnings are untyped strings, so startup-failure warnings may remain stale after recovery.
    const warning = combineLaunchWarnings(placed.warning, created.warning)
    const delivered =
      created.outcome.kind === 'terminal'
        ? { ...execution, intent: acceptedTerminalIntent(intent, acceptance) }
        : execution
    const surface = published(execution, {
      outcome: created.outcome,
      worktreeId: placed.worktreeId,
      receipt: settled,
      ...(warning ? { warning } : {}),
      ...promptReceipt(delivered.intent, settledAtCreation(delivered.intent, created))
    })
    surfacePublished = true
    launch?.release()
    return {
      ...surface,
      ...promptReceipt(delivered.intent, await settleLaunchPromptDisposal(delivered, created))
    }
  } catch (error) {
    const createdWorktreeId = recoverableWorktreeId ?? launch?.createdWorktreeId()
    if (
      !surfacePublished &&
      intent.target.kind !== 'existing' &&
      createdWorktreeId &&
      !(error instanceof AgentLaunchSetupNotCompletedError && error.outcome.kind === 'failed')
    ) {
      await recoverCreatedWorkspace(execution.workspaces, createdWorktreeId)
    }
    throw error
  } finally {
    launch?.release()
  }
}

function published(execution: AgentLaunchExecution, surface: AgentLaunchResult): AgentLaunchResult {
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

/** Keep the structured create receipt for prompt settlement. */
export type CreatedSurface = {
  outcome: AgentLaunchResult['outcome']
  warning?: string
  terminalCreation?: RuntimeTerminalCreate
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
      ...(intent.chatOptions ? { chatOptions: intent.chatOptions } : {}),
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(reservedTabId ? { tabId: reservedTabId } : {}),
      ...launchPromptCreateInputs(intent, execution.signal),
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
