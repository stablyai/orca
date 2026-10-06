import type { Repo } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions
} from '../../shared/local-windows-terminal-runtime'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimeForWorktreeId
} from '../local-project-runtime-resolution'
import type { RuntimeStore } from './runtime-store-contract'

export function assertNativeCodexAccountPlacement(args: {
  store: Pick<RuntimeStore, 'getSettings' | 'getRepo' | 'getProjects'>
  repo: Repo | null
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  worktreeId?: string
  cwd: string
  shellOverride?: string
}): void {
  if (
    args.connectionId ||
    (args.executionHostId && args.executionHostId !== 'local') ||
    (args.repo && getRepoExecutionHostId(args.repo) !== 'local')
  ) {
    throw new Error(
      '--account supports the connected runtime native host only; SSH and forwarded workspaces are unsupported.'
    )
  }
  const settings = args.store.getSettings()
  if (hasExplicitTuiLaunchCommand(settings, 'codex')) {
    throw new Error('--account cannot guarantee the account with a custom Codex launch command.')
  }
  if (isWslUncPath(args.cwd)) {
    throw new Error('--account does not support WSL workspaces.')
  }
  if (process.platform === 'win32') {
    const projectRuntime = args.worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(args.store, args.worktreeId)
      : args.repo
        ? resolveLocalProjectRuntimeForRepo(args.store, args.repo)
        : undefined
    const options = resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: args.shellOverride,
      settings,
      projectRuntime
    })
    if (isWslShellName(options.shellOverride)) {
      throw new Error('--account does not support WSL execution; select a native host workspace.')
    }
  }
}
