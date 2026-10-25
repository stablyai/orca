import type { AgentLaunchIntent } from '../../../../shared/agent-launch-intent'
import type { CreateWorktreeProgressEvent } from '../../../../shared/worktree/create-types'
import type { AgentLaunchExecution } from '../../../agent-launch/agent-launch-execution'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
/**
 * Creating the worktree an `agent.launch` asks for.
 *
 * `startupAgent` is the whole fork, and it is the same one `worker-worktree-creation` makes: a
 * terminal launch creates the worktree agent-first, so the startup terminal IS the agent, while a
 * structured launch creates it with no agent at all and its session is created for the worktree
 * afterwards. Setup, default tabs, provenance and lineage are identical either way.
 *
 * The executor owns which side of that fork this call lands on; nothing here re-decides it.
 */

import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import type { AgentLaunchWorkspaceFactory } from '../../../agent-launch/agent-launch-surface-factories'
import { combineLaunchWarnings } from '../../../agent-launch/agent-launch-warnings'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { buildManagedWorktreeCreateArgs, worktreeCreateRepoSelector } from './worktree-create-args'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch-preferences'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { agentLaunchFolderWorkspaceCreator } from './agent-launch-folder-workspace-creation'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'

type WorktreeCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-worktree' }
>['create']

export function agentLaunchWorkspaceFactory(
  context: RpcContext,
  agent: TuiAgent,
  createIdentity?: AgentLaunchIntent['createIdentity']
): AgentLaunchWorkspaceFactory {
  return {
    createFolderWorkspace: agentLaunchFolderWorkspaceCreator(context, agent),
    createRecoveryShell: async (worktreeId) => {
      await context.runtime.createTerminal(`id:${worktreeId}`, { surfaceOwner: false })
    },
    createWorktree: async ({
      create,
      startupAgent,
      promisedAgentChat,
      onWorkspaceCreated,
      initializeSurface,
      startupPrompt,
      agentArgs,
      cwd,
      launchSource,
      paneKey,
      options,
      accountEnv
    }) => {
      const startupLaunchPreferences = toAgentLaunchPreferences(options)
      let promptRodeLaunchCommand = false
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: already validated by `AgentLaunch`; the executor only removed the reserved agent fields, so the rest of the payload is the parsed shape.
      const params = create as WorktreeCreateParams
      const { runtime } = context
      const repo = await runtime.showRepo(worktreeCreateRepoSelector(params))
      const automationProvenance = resolveAutomationWorkspaceProvenance({
        authority: runtime,
        repoSelector: params.repo,
        repo,
        request: params.automationProvenanceRequest
      })
      // Reserved before creation so a retry can recover; a failed attempt has to release it.
      try {
        const createArgs = {
          ...(createIdentity ? { requestedInstanceId: createIdentity.instanceId } : {}),
          ...buildManagedWorktreeCreateArgs(
            {
              ...(agentLaunchMovesHostWindow(context) ? params : withoutHostActivation(params)),
              ...(startupAgent ? { startupAgent } : {}),
              // Only ever set alongside `startupAgent`, which is what the create requires; the
              // executor offers it only to an agent that takes its prompt on argv, and it rides only
              // when the typed line can carry it.
              ...(startupPrompt ? { startupPrompt } : {})
            },
            {
              automationProvenance,
              cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
                startupAgent: agent,
                createdAt: Date.now()
              }),
              creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
            },
            context
          ),
          ...(agentArgs !== undefined ? { startupAgentArgs: agentArgs } : {}),
          ...(startupPrompt
            ? {
                onStartupPromptCarry: (carried: boolean) => {
                  promptRodeLaunchCommand = carried
                }
              }
            : {}),
          ...(cwd ? { startupCwd: cwd } : {}),
          ...(launchSource ? { startupLaunchSource: launchSource } : {}),
          ...(paneKey ? { startupPaneKey: paneKey } : {}),
          ...(startupLaunchPreferences ? { startupLaunchPreferences } : {}),
          ...(accountEnv ? { startupAccountEnv: { ...accountEnv } } : {}),
          // The launch owns the agent whichever surface it settles on, so the workspace records
          // it even when no startup terminal was created for it.
          ...(context.clientKind === 'runtime' ? { telemetryEntryPoint: 'app' as const } : {}),
          createdWithAgent: agent,
          ...(promisedAgentChat ? { promisedAgentChat } : {}),
          ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
          ...(context.clientKind === 'runtime'
            ? {
                onProgress: (progress: Omit<CreateWorktreeProgressEvent, 'creationId'>) =>
                  runtime.notifyWorktreeCreationProgress({
                    ...progress,
                    creationId: params.creationId
                  })
              }
            : {}),
          ...(initializeSurface
            ? {
                initializeSurface: async (
                  workspace: Parameters<NonNullable<typeof initializeSurface>>[0]
                ) => {
                  return initializeSurface({
                    ...workspace,
                    ...(promptRodeLaunchCommand ? { promptRodeLaunchCommand } : {})
                  })
                }
              }
            : {}),
          awaitTerminalProvisioning: true,
          // Lets the hold see setup end even when its terminal's shell stays open.
          observeSetupCompletion: true
        }
        let result
        try {
          result = await runtime.createManagedWorktree(createArgs)
        } catch (error) {
          if (
            !params.parentWorkspace ||
            !hasRuntimeRpcErrorCode(error, 'LINEAGE_PARENT_NOT_FOUND')
          ) {
            throw error
          }
          console.warn('[agent-launch] Parent workspace no longer exists; creating without it.')
          result = await runtime.createManagedWorktree({
            ...createArgs,
            lineage: { noParent: true }
          })
        }
        finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        const warning =
          result.warnings?.reduce(
            (combined, lineage) => combineLaunchWarnings(combined, lineage.message),
            result.warning
          ) ?? result.warning
        return {
          created: result,
          worktreeId: result.worktree.id,
          workspacePath: result.worktree.path,
          connectionId: repo.connectionId ?? null,
          startupTerminalHandle: result.startupTerminal?.handle,
          ...(promptRodeLaunchCommand ? { promptRodeLaunchCommand } : {}),
          ...(result.startupTerminal?.paneKey
            ? { startupTerminalPaneKey: result.startupTerminal.paneKey }
            : {}),
          ...(warning ? { warning } : {})
        }
      } catch (error) {
        releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        throw error
      }
    }
  }
}

/**
 * A paired device's create leaves the host window where it is, as the rest of its launch does:
 * activating would switch the desktop to the new workspace and reveal the startup terminal there.
 * Without it, setup and default tabs are provisioned in the background instead. `runHooks` means
 * "run setup, and activate", so only its setup half is kept.
 */
function withoutHostActivation(params: WorktreeCreateParams): WorktreeCreateParams {
  return {
    ...params,
    activate: false,
    runHooks: false,
    ...(params.runHooks === true ? { setupDecision: 'run' as const } : {})
  }
}

export function agentLaunchWorkspaceCreation(
  context: RpcContext,
  intent: AgentLaunchIntent
): Pick<AgentLaunchExecution, 'workspaces'> {
  return {
    workspaces: agentLaunchWorkspaceFactory(context, intent.agent, intent.createIdentity)
  }
}
