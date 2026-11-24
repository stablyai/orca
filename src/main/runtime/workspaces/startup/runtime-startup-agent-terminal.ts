import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/creation/launch-types'
import { paneIdentity } from '../../terminal/identity/runtime-terminal-pane-identity'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type { RuntimeManagedWorktreeCreateArgs } from '../creation/runtime-managed-worktree-create-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { StartupPromptDeliveryGuard } from './runtime-worktree-startup-readiness'

/** The terminal operations a workspace's startup agent needs. */
export type StartupAgentTerminalPorts = {
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (
    handle: string,
    draft: WorktreeStartupDraftPaste,
    guard?: StartupPromptDeliveryGuard
  ) => void
  sendFollowup: (
    handle: string,
    followup: WorktreeStartupFollowup,
    terminal: RuntimeTerminalCreate,
    guard?: StartupPromptDeliveryGuard
  ) => void
}

/** A trusted create's approval of the agent it starts, asked again after each wait; a throw refuses the effect. */
export function startupEffectApproval(
  request: Pick<RuntimeManagedWorktreeCreateArgs, 'beforeEffect' | 'signal'>
) {
  const assertAllowed = (): void => {
    request.beforeEffect?.()
    request.signal?.throwIfAborted()
  }
  return {
    assertAllowed,
    /** The startup terminal's preparation awaits, so its caller is approved again right before the PTY spawns. */
    spawnOptions: {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.beforeEffect ? { onPtySpawnDispatched: request.beforeEffect } : {})
    } satisfies Pick<TerminalCreateOptions, 'signal' | 'onPtySpawnDispatched'>,
    /** A draft or follow-up waits for the agent; its caller's approval travels to the write. */
    promptGuard: {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.beforeEffect ? { beforeWrite: request.beforeEffect } : {})
    } satisfies StartupPromptDeliveryGuard
  }
}

/** What every startup agent's terminal is created with; a surface adds what is its own. */
export function startupAgentTerminalOptions(args: {
  request: Pick<RuntimeManagedWorktreeCreateArgs, 'startupCwd' | 'startupPaneKey'>
  startup: WorktreeStartupLaunch
  launchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
}): TerminalCreateOptions {
  const { request, startup, launchRuntime, createdWithAgent } = args
  return {
    command: startup.command,
    ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
    ...paneIdentity(request.startupPaneKey),
    env: startup.env,
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(createdWithAgent ? { launchAgent: createdWithAgent } : {}),
    ...(launchRuntime instanceof Error
      ? { startFailure: launchRuntime }
      : launchRuntime
        ? { launchRuntime }
        : {}),
    ...(startup.viewMode ? { viewMode: startup.viewMode } : {}),
    startupCommandDelivery: startup.startupCommandDelivery,
    telemetry: startup.telemetry,
    // Keep failed starts visible in their panes.
    ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { keepPaneOnStartFailure: true as const } : {})
  }
}

/** Start the workspace's agent, then hand it the draft or prompt its create owes it. Approval is asked
 *  again right before the PTY spawns and, once the agent is up, before anything is pasted into it. */
export async function startStartupAgentTerminal(args: {
  worktreeId: string
  approval: ReturnType<typeof startupEffectApproval>
  ports: StartupAgentTerminalPorts
  options: TerminalCreateOptions
  onStartupTerminalCreated?: (terminal: RuntimeTerminalCreate) => void
  draftPaste?: WorktreeStartupDraftPaste
  startupFollowup?: WorktreeStartupFollowup
}): Promise<RuntimeTerminalCreate> {
  const { worktreeId, approval, ports, options } = args
  const terminal = await ports.createTerminal(`id:${worktreeId}`, {
    ...options,
    ...approval.spawnOptions
  })
  args.onStartupTerminalCreated?.(terminal)
  // The agent is up; its prompt is still the caller's to have approved.
  approval.assertAllowed()
  if (args.draftPaste) {
    ports.pasteDraft(terminal.handle, args.draftPaste, approval.promptGuard)
  }
  if (args.startupFollowup) {
    ports.sendFollowup(terminal.handle, args.startupFollowup, terminal, approval.promptGuard)
  }
  return terminal
}
