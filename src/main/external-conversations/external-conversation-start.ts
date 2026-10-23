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
  /** The launched workspace as hook rows name it, qualified by the host that runs it. */
  paneWorkspace(worktreeId: string): Promise<AgentPaneWorkspace>
}

/**
 * `agent.launch`'s own executor and factories with no paired caller: a background terminal agent
 * that takes the prompt on argv, in a workspace the target names or creates (worktree or folder).
 */
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

/**
 * Launches the conversation's agent and links its pane as soon as the surface is published. Only
 * a failure before anything was published throws, so its delivery id may retry; after that an
 * agent may exist, so any failure, the link's included, is `unknown` and never launches again.
 */
export async function launchConversation(
  launcher: ConversationLauncher,
  input: ConversationLaunchInput,
  signal: AbortSignal,
  writeLink: (workspace: AgentPaneWorkspace, paneKey: string) => void,
  /** Called synchronously at publication with the agent's pane, null when it has none. */
  onPublished: (paneKey: string | null) => void
): Promise<Delivery> {
  // Settled to its error, so a failed write waits for the launch instead of going unhandled.
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
      // Turned off before the agent existed: the launch stopped before any effect.
      if (signal.aborted) {
        return refused('connectors_disabled')
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
