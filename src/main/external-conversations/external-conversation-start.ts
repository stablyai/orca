import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { ConnectorAgent } from '../../shared/external-conversation-link'
import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { AgentLaunchPublishedSurface } from '../agent-launch/agent-launch-execution'
import {
  agentPaneWorkspace,
  type AgentPaneWorkspace
} from '../agent-hooks/agent-transition-detector'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolveUnlaunchedIntent } from '../runtime/rpc/methods/agent-launch-intent-resolution'
import { agentLaunchSurfaceFactory } from '../runtime/rpc/methods/agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from '../runtime/rpc/methods/agent-launch-worktree-creation'
import { refusalOf } from './external-conversation-chain'
import { refused, type Delivery } from './external-conversation-types'

export type ConversationLaunchInput = {
  agent: ConnectorAgent
  target: AgentLaunchParams['target']
  prompt: string
}

export type ConversationLauncher = {
  launch(
    input: ConversationLaunchInput,
    onSurfacePublished: (surface: AgentLaunchPublishedSurface) => void,
    signal: AbortSignal
  ): Promise<AgentLaunchResult>
  paneWorkspace(worktreeId: string): Promise<AgentPaneWorkspace>
}

/** Reuse agent.launch so conversations support both git worktrees and folder workspaces. */
export function runtimeConversationLauncher(runtime: OrcaRuntimeService): ConversationLauncher {
  const context = { runtime }
  return {
    launch: async ({ agent, target, prompt }, onSurfacePublished, signal) => {
      const intent = await resolveUnlaunchedIntent(
        { agent, target, prompt: { text: prompt, delivery: 'submit' } },
        runtime,
        null
      )
      return executeAgentLaunch({
        runtime,
        intent,
        terminalOnly: true,
        surfaces: agentLaunchSurfaceFactory(context, undefined, undefined, false, undefined, {
          early: null,
          presentation: 'background'
        }),
        workspaces: agentLaunchWorkspaceFactory(context, agent),
        onSurfacePublished,
        signal
      })
    },
    paneWorkspace: async (worktreeId) => {
      const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      return agentPaneWorkspace(scope.id, scope.connectionId)
    }
  }
}

/** After surface publication, failures are unknown rather than retryable because an agent may already exist. */
export async function launchConversation(
  launcher: ConversationLauncher,
  input: ConversationLaunchInput,
  signal: AbortSignal,
  writeLink: (workspace: AgentPaneWorkspace, paneKey: string) => void,
  /** Called synchronously at publication with the agent's pane, null when it has none. */
  onPublished: (paneKey: string | null) => void
): Promise<Delivery> {
  // Settle link errors as values so they wait for launch instead of becoming unhandled rejections.
  const surface: { published: boolean; linked: Promise<unknown> | null } = {
    published: false,
    linked: null
  }
  const onSurfacePublished = (published: AgentLaunchPublishedSurface): void => {
    surface.published = true
    const { outcome } = published
    const paneKey = outcome.kind === 'terminal' ? (outcome.paneKey ?? null) : null
    onPublished(paneKey)
    if (paneKey) {
      surface.linked = launcher
        .paneWorkspace(published.worktreeId)
        .then((workspace) => writeLink(workspace, paneKey))
        .then(
          () => null,
          (error: unknown) => error ?? new Error('connector_link_failed')
        )
    }
  }
  let result: AgentLaunchResult | null = null
  try {
    result = await launcher.launch(input, onSurfacePublished, signal)
  } catch (error) {
    if (!surface.published) {
      if (signal.aborted) {
        return refused(refusalOf(signal))
      }
      throw error
    }
  }
  const linkError = surface.linked
    ? await surface.linked
    : new Error('connector_launch_without_pane')
  if (linkError) {
    console.warn(
      '[connectors] the agent launched but its conversation link was not written',
      linkError
    )
    return { outcome: 'unknown', reason: 'launch_outcome_unknown' }
  }
  return result?.prompt?.outcome === 'handed-to-terminal'
    ? { outcome: 'accepted' }
    : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
}
