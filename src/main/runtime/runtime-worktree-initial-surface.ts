import type { Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type {
  AgentLaunchWorkspace,
  AgentLaunchTerminalSequence
} from '../agent-launch/agent-launch-surface-factories'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'

export function worktreeInitialSurfaceWorkspace(
  worktree: Worktree,
  repo: Repo,
  terminal: {
    startupTerminalHandle: string | null
    startupTerminalTabId: string | null
    startupTerminalPaneKey: string | null
    startupTerminalPtyId: string | null
    warning?: string
  }
): AgentLaunchWorkspace {
  return {
    worktreeId: worktree.id,
    workspacePath: worktree.path,
    connectionId: getRepoSshConnectionId(repo),
    startupTerminalHandle: terminal.startupTerminalHandle ?? undefined,
    ...(terminal.startupTerminalPaneKey
      ? { startupTerminalPaneKey: terminal.startupTerminalPaneKey }
      : {}),
    ...(terminal.warning ? { warning: terminal.warning } : {}),
    created: {
      worktree,
      ...(terminal.startupTerminalHandle
        ? {
            startupTerminal: {
              spawned: true,
              handle: terminal.startupTerminalHandle,
              tabId: terminal.startupTerminalTabId ?? undefined,
              paneKey: terminal.startupTerminalPaneKey,
              ptyId: terminal.startupTerminalPtyId
            }
          }
        : {})
    }
  }
}

export function sequenceWorktreeSetupAgent(
  setup: NonNullable<CreateWorktreeResult['setup']>,
  command: string
) {
  return createSequencedSetupAgentCommands({
    runnerScriptPath: setup.runnerScriptPath,
    startupCommand: command,
    platform: getSetupRunnerCommandPlatformForPath(
      setup.runnerScriptPath,
      process.platform === 'win32' ? 'windows' : 'posix'
    ),
    shell: setup.shell
  })
}

export function sequenceInitialTerminalCommand<
  T extends { command?: string; env?: Record<string, string> }
>(options: T, sequence?: AgentLaunchTerminalSequence): T {
  if (!options.command || !sequence) {
    return options
  }
  const sequenced = sequence(options.command)
  return { ...options, command: sequenced.command, env: { ...options.env, ...sequenced.env } }
}

export function appendWorktreeTerminalFailure(
  warning: string | undefined,
  path: string,
  kind: 'startup' | 'initial',
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error)
  const failure = `failed to create the ${kind} terminal for ${path}: ${message}`
  const combined = warning
    ? `${warning} Also ${failure}`
    : `${failure[0].toUpperCase()}${failure.slice(1)}`
  console.warn(`[worktree-create] ${combined}`)
  return combined
}

export function worktreeSetupPlatform(
  setup: CreateWorktreeResult['setup'],
  fallback: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallback)
}

export function worktreeOwnerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}
