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
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import type { AgentLaunchWorkspaceFactory } from '../../../agent-launch/agent-launch-executor'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import type { AgentLaunchParams } from './agent-launch-schemas'

type WorktreeCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-worktree' }
>['create']

const STRUCTURED_SETUP_WAIT_TIMEOUT_MS = 60_000

export function agentLaunchWorkspaceFactory(
  context: RpcContext,
  agent: TuiAgent
): AgentLaunchWorkspaceFactory {
  return {
    createWorktree: async ({ create, startupAgent, startupPrompt }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: already validated by `AgentLaunch`; the executor only removed the reserved agent fields, so the rest of the payload is the parsed shape.
      const params = create as WorktreeCreateParams
      const { runtime } = context
      const repo = await runtime.showRepo(params.repo)
      const automationProvenance = resolveAutomationWorkspaceProvenance({
        authority: runtime,
        repoSelector: params.repo,
        repo,
        request: params.automationProvenanceRequest
      })
      // Reserved before creation so a retry can recover; a failed attempt has to release it.
      try {
        const result = await runtime.createManagedWorktree({
          ...buildManagedWorktreeCreateArgs(
            {
              ...params,
              ...(startupAgent ? { startupAgent } : {}),
              // Only ever set alongside `startupAgent`, which is what the create requires; the
              // executor sends it exclusively for an agent that takes its prompt on argv, so this
              // is the startup command carrying the text rather than a second delivery path.
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
            context.clientKind ? { clientKind: context.clientKind } : {}
          ),
          // The launch owns the agent whichever surface it settles on, so the workspace records
          // it even when no startup terminal was created for it.
          createdWithAgent: agent,
          // Structured sessions have no startup command to sequence behind setup. Provision the
          // setup terminal synchronously and attach a completion token so the launch can wait
          // before creating the chat surface.
          awaitTerminalProvisioning: true,
          observeSetupCompletion: true
        })
        if (!startupAgent) {
          await waitForStructuredSetup(runtime, result.setupReceipt)
        }
        finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        return {
          worktreeId: result.worktree.id,
          startupTerminalHandle: result.startupTerminal?.handle,
          // Carried, not dropped: `createManagedWorktree` reports a failed startup terminal or an
          // uncopied working tree here, and it is the only place the host says so.
          ...(result.warning ? { warning: result.warning } : {})
        }
      } catch (error) {
        releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        throw error
      }
    }
  }
}

async function waitForStructuredSetup(
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>,
  receipt: Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>['setupReceipt']
): Promise<void> {
  if (
    !receipt ||
    receipt.startupPolicy !== 'wait-for-setup' ||
    receipt.state !== 'running' ||
    !receipt.terminalHandle
  ) {
    return
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      runtime.waitForSetupTerminalCompletion(receipt.terminalHandle, abort.signal),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abort.abort(new Error('structured_setup_wait_timeout'))
          resolve()
        }, STRUCTURED_SETUP_WAIT_TIMEOUT_MS)
      })
    ])
  } catch {
    // Setup completion is evidence, not a reason to strand a launch when the PTY disappears.
  } finally {
    clearTimeout(timer)
  }
}
