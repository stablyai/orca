import { resolveWorkspace } from './agent-launch-workspace-resolution'
import {
  AgentLaunchFoundingIncompleteError,
  assertHostFoundingNotCancelled
} from './host-founding-attempt'
import { AgentLaunchCancelledError } from '../../shared/agent-launch-cancellation'
import {
  createLaunchSurface,
  createLaunchTerminalSurface,
  type CreatedSurface
} from './agent-launch-surface-creation'
/** Structured launches create the workspace without an agent, then ask its host for chat support.
 * The host needs the created workspace to answer; a definitive refusal starts a terminal agent. */

import { assertAgentPromptRequestActive } from '../runtime/orca-runtime-core'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import { combineLaunchWarnings } from './agent-launch-warnings'
import {
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
  type AgentLaunchModeSettlement,
  DEFAULT_LAUNCH_VOCABULARY,
  downgradeAgentLaunchModeForStructuredRefusal,
  warnStructuredLaunchDowngrade
} from './agent-launch-mode'
import { assertLegacyHostTarget, legacyHostCreateResult } from './agent-launch-legacy-host'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchInitialSurfaceStage
} from './agent-launch-surface-factories'
import type { AgentLaunchExecution, AgentLaunchPublishedSurface } from './agent-launch-execution'
import {
  beginCreatedWorkspaceLaunch,
  recoverCreatedWorkspace
} from './agent-launch-created-workspace'

export type { AgentLaunchExecution, AgentLaunchPublishedSurface } from './agent-launch-execution'

export async function executeAgentLaunch(
  execution: AgentLaunchExecution
): Promise<AgentLaunchResult> {
  const { intent, runtime } = execution
  const attempt = execution.hostFoundingAttempt ?? {}
  execution = { ...execution, hostFoundingAttempt: attempt }
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
    intent.target.kind === 'create-worktree'
      ? beginCreatedWorkspaceLaunch(runtime, intent.agent)
      : undefined
  let placed: Awaited<ReturnType<typeof resolveWorkspace>> | undefined
  let surfacePublished = false
  let recoverableWorktreeId: string | undefined
  try {
    let initialSurface: AgentLaunchPublishedSurface | undefined
    let initializationHandled = false
    let deferredFailure: Error | undefined
    let promptDisposal: (() => Promise<AgentLaunchResult>) | undefined
    const initializeSurface: AgentLaunchInitialSurfaceStage = async (placed) => {
      if (intent.target.kind === 'create-worktree' && execution.hostFoundingAttempt) {
        execution.hostFoundingAttempt.createdWorktreeId = placed.worktreeId
      }
      if (initializationHandled) {
        return initialSurface
      }
      initializationHandled = true
      if (attempt.cancellation?.requested) {
        deferredFailure = new AgentLaunchCancelledError()
        return
      }
      // Agent-first creation already produced the agent, so the pre-flight verdict is final.
      if (placed.startupTerminalHandle) {
        const startupHandle = placed.startupTerminalHandle
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
        initialSurface = startup
        promptDisposal = () =>
          (async () => ({
            ...startup,
            ...promptReceipt(
              intent,
              placed.promptRodeLaunchCommand
                ? HANDED_TO_TERMINAL
                : await deliverTerminalLaunchPrompt(execution, startupHandle, {
                    freshLaunch: true
                  })
            )
          }))()
        return startup
      }

      recoverableWorktreeId = execution.signal?.aborted ? placed.worktreeId : undefined
      assertAgentPromptRequestActive(execution.signal)
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
        assertAgentPromptRequestActive(execution.signal)
        assertHostFoundingNotCancelled(attempt)
        created = await createLaunchSurface(execution, placed, settled)
      } catch (error) {
        if (attempt.cancellation?.requested) {
          deferredFailure = new AgentLaunchCancelledError()
          return
        } else if (error instanceof AgentLaunchFoundingIncompleteError) {
          deferredFailure = error
          if (!error.surface) {
            return
          }
          created = {
            outcome: {
              kind: 'structured',
              sessionId: error.surface.sessionId,
              handle: error.surface.handle,
              ...(error.surface.tabId ? { tabId: error.surface.tabId } : {})
            },
            structured: error.surface
          }
        } else {
          if (
            settled.mode !== 'structured' ||
            !(error instanceof AgentLaunchStructuredSessionRefusedError) ||
            !isDefinitiveAgentSessionCreateRefusal(error.code)
          ) {
            throw error
          }
          assertAgentPromptRequestActive(execution.signal)
          settled = downgradeAgentLaunchModeForStructuredRefusal(settled, vocabulary, settlement)
          created = await createLaunchTerminalSurface(execution, placed)
        }
      }
      const warning = combineLaunchWarnings(placed.warning, created.warning)
      const surface: AgentLaunchPublishedSurface = {
        outcome: created.outcome,
        worktreeId: placed.worktreeId,
        receipt: settled,
        ...(warning ? { warning } : {}),
        ...promptReceipt(intent, settledAtCreation(intent, created))
      }
      admitted(execution, surface)
      const installed = !attempt.disposition || attempt.publication !== undefined
      if (installed) {
        published(execution, surface, false)
        surfacePublished = true
        launch?.release()
      }
      initialSurface = surface
      promptDisposal = created.structured
        ? async () => surface
        : async () => ({
            ...surface,
            ...promptReceipt(intent, await settleLaunchPromptDisposal(execution, created))
          })
      return installed ? surface : undefined
    }
    placed = await resolveWorkspace(
      execution,
      preflight,
      launch?.onWorkspaceCreated,
      initializeSurface
    )
    // Existing workspaces and older internal factories have no staged provisioning.
    if (!initializationHandled) {
      await initializeSurface(placed)
    }
    if (deferredFailure) {
      throw deferredFailure
    }
    if (!promptDisposal) {
      throw new Error('agent_launch_surface_missing')
    }
    return { ...(await promptDisposal()), ...(placed.created ? { created: placed.created } : {}) }
  } catch (error) {
    const createdWorktreeId = recoverableWorktreeId ?? launch?.createdWorktreeId()
    if (
      !surfacePublished &&
      !attempt.cancellation?.requested &&
      !attempt.disposition &&
      intent.target.kind !== 'existing' &&
      createdWorktreeId
    ) {
      await recoverCreatedWorkspace(execution.workspaces, createdWorktreeId)
    }
    throw error
  } finally {
    launch?.release()
  }
}

function published(
  execution: AgentLaunchExecution,
  surface: AgentLaunchPublishedSurface,
  recordAdmission = true
): AgentLaunchPublishedSurface {
  if (recordAdmission) {
    admitted(execution, surface)
  }
  warnStructuredLaunchDowngrade(execution.intent.agent, surface.receipt)
  execution.onSurfacePublished?.(surface)
  return surface
}

function admitted(execution: AgentLaunchExecution, surface: AgentLaunchPublishedSurface): void {
  try {
    execution.onSurfaceAdmitted?.(surface)
  } catch (error) {
    console.warn('[agent-launch] recording an admitted surface failed', error)
  }
}
