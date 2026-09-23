import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { assertClaudeBoundHomeUsable } from './claude-bound-home-refusal'
import { claudeConfigDirEnvPatch, isCustomClaudeConfigDir } from './claude-config-dir-pin'
import {
  claudeChildLaunchEnv,
  resolveClaudeHomeBindingForSession,
  type ClaudeHomeBindingCatalogSource
} from './claude-structured-account-home'

/** Resolve at the PTY boundary: desktop tabs do not pass through runtime terminal creation. */
export async function prepareClaudeTerminalBoundAuth(
  deps: {
    store?: ClaudeHomeBindingCatalogSource
    prepareClaudeAuth?: (
      target?: ClaudeAccountSelectionTarget
    ) => Promise<ClaudeRuntimeAuthPreparation>
  },
  args: { worktreeId?: string; env?: NodeJS.ProcessEnv },
  target: ClaudeAccountSelectionTarget
): Promise<ClaudeRuntimeAuthPreparation | null> {
  const fallback = async () => (await deps.prepareClaudeAuth?.(target)) ?? null
  if (!deps.store || !args.worktreeId || target.runtime === 'wsl') {
    return fallback()
  }
  const binding = resolveClaudeHomeBindingForSession({
    store: deps.store,
    workspaceId: args.worktreeId,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  // An earlier launch stage may already have pinned the binding in the overlay.
  if (!binding || !isCustomClaudeConfigDir(binding.configDir)) {
    return fallback()
  }
  await assertClaudeBoundHomeUsable({
    binding,
    location: { executionHostId: LOCAL_EXECUTION_HOST_ID, wslDistro: null },
    launchEnv: claudeChildLaunchEnv(args.env)
  })
  return {
    configDir: binding.configDir,
    runtime: 'host',
    envPatch: claudeConfigDirEnvPatch(binding.configDir),
    stripAuthEnv: true,
    provenance: `project-group:${binding.groupId}`
  }
}
