/** Terminal launches create agent-first worktrees; structured launches create the workspace without an agent and add chat afterwards.
 * The executor chooses; setup, default tabs, provenance and lineage use the normal create path. */

import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance,
  resolveClientAutomationWorkspaceProvenance
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
import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/setup-agent-startup-policy'
import { assertAgentPromptRequestActive } from '../../orca-runtime-core'
import { AgentLaunchSetupError } from '../../../agent-launch/agent-launch-setup-error'

type WorktreeCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-worktree' }
>['create']

export function agentLaunchWorkspaceFactory(
  context: RpcContext,
  agent: TuiAgent
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
      startupPrompt,
      agentArgs,
      cwd,
      launchSource,
      paneKey,
      options,
      accountEnv,
      signal
    }) => {
      const startupLaunchPreferences =
        startupAgent && toAgentLaunchPreferences(options, startupAgent)
      let promptRodeLaunchCommand = false
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: already validated by `AgentLaunch`; the executor only removed the reserved agent fields, so the rest of the payload is the parsed shape.
      const params = create as WorktreeCreateParams
      const { runtime } = context
      const repo = await runtime.showRepo(worktreeCreateRepoSelector(params))
      const automationProvenance =
        resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest,
          ignoreUnknownAutomation: true
        }) ??
        resolveClientAutomationWorkspaceProvenance({
          authority: runtime,
          provenance: params.clientAutomationProvenance
        })
      // Reserved before creation so a retry can recover; a failed attempt has to release it.
      try {
        const result = await runtime.createManagedWorktree({
          ...buildManagedWorktreeCreateArgs(
            {
              ...(agentLaunchMovesHostWindow(context) ? params : withoutHostActivation(params)),
              ...(startupAgent ? { startupAgent } : {}),
              // Only offer startupPrompt with startupAgent when the typed line can carry it.
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
          // Record the launch's agent on the workspace even when it has no startup terminal.
          createdWithAgent: agent,
          ...(promisedAgentChat ? { promisedAgentChat } : {}),
          ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
          // Chats have no startup command to sequence after setup; provision setup synchronously and return its completion token.
          awaitTerminalProvisioning: true,
          observeSetupCompletion: true
        })
        if (!startupAgent || !result.startupTerminal?.handle) {
          await waitForStructuredSetup(runtime, result.setupReceipt, signal)
        }
        finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        const warning =
          result.warnings?.reduce(
            (combined, lineage) => combineLaunchWarnings(combined, lineage.message),
            result.warning
          ) ?? result.warning
        return {
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

/** Paired creates provision setup/default tabs in the background; split runHooks (setup plus activation) to keep setup without moving the host window. */
function withoutHostActivation(params: WorktreeCreateParams): WorktreeCreateParams {
  return {
    ...params,
    activate: false,
    runHooks: false,
    ...(params.runHooks === true ? { setupDecision: 'run' as const } : {})
  }
}

async function waitForStructuredSetup(
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>,
  receipt: Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>['setupReceipt'],
  signal?: AbortSignal
): Promise<void> {
  assertAgentPromptRequestActive(signal)
  if (
    !receipt ||
    receipt.startupPolicy !== 'wait-for-setup' ||
    receipt.state === 'skipped' ||
    receipt.state === 'not_configured'
  ) {
    return
  }
  if (receipt.state !== 'running' || !receipt.terminalHandle) {
    throw new AgentLaunchSetupError(
      'agent_setup_unconfirmed',
      'Required setup did not start with a completion observer. The workspace is retained; complete setup before launching the agent.'
    )
  }
  const abort = new AbortController()
  const setupSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let completion: { exitCode: number | null }
  try {
    completion = await Promise.race([
      runtime.waitForSetupTerminalCompletion(receipt.terminalHandle, setupSignal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('structured_setup_wait_timeout'))
          abort.abort()
        }, DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
      })
    ])
  } catch {
    assertAgentPromptRequestActive(signal)
    throw new AgentLaunchSetupError(
      abort.signal.aborted ? 'agent_setup_timeout' : 'agent_setup_unconfirmed',
      abort.signal.aborted
        ? 'Required setup did not finish before its deadline. The workspace is retained; complete setup before launching the agent.'
        : 'Setup completion could not be verified. The workspace is retained; complete setup before launching the agent.'
    )
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
  if (completion.exitCode !== 0) {
    throw new AgentLaunchSetupError(
      completion.exitCode === null ? 'agent_setup_unconfirmed' : 'agent_setup_failed',
      completion.exitCode === null
        ? 'Setup ended without a confirmed exit code. The workspace is retained; complete setup before launching the agent.'
        : `Setup exited with code ${completion.exitCode}. The workspace is retained; fix setup before launching the agent.`
    )
  }
}
