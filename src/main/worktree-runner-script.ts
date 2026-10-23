import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { shouldWaitForSetupBeforeAgentStartup } from '../shared/setup-agent-startup-policy'
import { nativeWindowsPathToPosixShellPath } from '../shared/setup-runner-command'
import { scriptDeclaresPosixShell } from '../shared/setup-script-shebang'
import { resolveWindowsShellStartupFamily } from '../shared/windows-terminal-shell'
import { resolveWindowsGitBashShellPath } from './git-bash'
import { gitExecFileSync } from './git/runner'
import { isWslPath, toWindowsWslPath, toLinuxPath } from './wsl'
import { getHookRuntimeTarget, getHookWslContext } from './hook-runtime-target'
import { SETUP_RUNNER_PATH_ENV_KEYS, getSetupRunnerEnvVars } from './setup-hook-env-vars'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from './setup-runner-script-text'
import type { HookRuntimeTarget } from './hook-runtime-target'
import type { Repo } from '../shared/repo-types'
import type { WorktreeSetupLaunch } from '../shared/worktree/launch-types'
import type { SetupAgentStartupPolicy } from '../shared/orca-yaml-hook-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { SetupRunnerShell } from '../shared/setup-runner-command'

type SetupRunnerShellSettings = Record<string, unknown> | undefined

function getGitPath(cwd: string, relativePath: string, runtimeTarget?: HookRuntimeTarget): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd,
    ...(runtimeTarget?.wslDistro ? { wslDistro: runtimeTarget.wslDistro } : {})
  }).trim()
}

export function createSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  setupShell?: SetupRunnerShell,
  projectStartupPolicy?: SetupAgentStartupPolicy
): WorktreeSetupLaunch {
  return createWorktreeRunnerScript({
    repo,
    worktreePath,
    script,
    runnerBaseName: 'setup-runner',
    runtimeTarget: getHookRuntimeTarget(projectRuntime),
    waitForAgentStartup: shouldWaitForSetupBeforeAgentStartup(
      repo.hookSettings?.setupAgentStartupPolicy,
      projectStartupPolicy
    ),
    setupShell
  })
}

export function createIssueCommandRunnerScript(
  repo: Repo,
  worktreePath: string,
  command: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  setupShell?: SetupRunnerShell
): WorktreeSetupLaunch {
  // Runner files avoid PTY line-editor wrapping or truncation of long commands.
  return createWorktreeRunnerScript({
    repo,
    worktreePath,
    script: command,
    runnerBaseName: 'issue-command-runner',
    runtimeTarget: getHookRuntimeTarget(projectRuntime),
    setupShell
  })
}

function createWorktreeRunnerScript(args: {
  repo: Repo
  worktreePath: string
  script: string
  runnerBaseName: 'setup-runner' | 'issue-command-runner'
  runtimeTarget?: HookRuntimeTarget
  waitForAgentStartup?: boolean
  setupShell?: SetupRunnerShell
}): WorktreeSetupLaunch {
  const {
    repo,
    worktreePath,
    script,
    runnerBaseName,
    runtimeTarget,
    waitForAgentStartup,
    setupShell
  } = args
  const envVars = getSetupRunnerEnvVars(repo, worktreePath)
  const wslWorktree = isWslPath(worktreePath) || Boolean(runtimeTarget?.wslDistro)
  const nativeWindowsWorktree = process.platform === 'win32' && !wslWorktree
  // Preserve existing Windows cmd script syntax; only a shebang opts into bash, regardless of terminal preference.
  const runnerShell: SetupRunnerShell = nativeWindowsWorktree
    ? setupShell?.family === 'posix' && scriptDeclaresPosixShell(script)
      ? setupShell
      : { family: 'cmd' }
    : { family: 'posix' }
  // Report the typing shell, not the runner format: cmd /c typed through Git Bash triggers MSYS path rewriting.
  const launchShell: SetupRunnerShell | undefined = nativeWindowsWorktree
    ? (setupShell ?? { family: 'cmd' })
    : process.platform === 'win32' && runtimeTarget?.wslDistro
      ? { family: 'posix', executable: 'wsl.exe' }
      : undefined
  // Linked worktrees have .git files; resolve the per-worktree gitdir through Git.
  const runnerExtension = runnerShell.family === 'cmd' ? 'cmd' : 'sh'
  const gitRelPath = `orca/${runnerBaseName}.${runnerExtension}`
  let runnerScriptPath = getGitPath(worktreePath, gitRelPath, runtimeTarget)

  // Convert WSL Git's Linux path to a path Windows filesystem calls can reach.
  if (wslWorktree) {
    const wslInfo = getHookWslContext(worktreePath, runtimeTarget)
    if (wslInfo?.distro) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }

  mkdirSync(dirname(runnerScriptPath), { recursive: true })

  if (runnerShell.family === 'cmd') {
    writeFileSync(runnerScriptPath, buildWindowsRunnerScript(script), 'utf-8')
  } else {
    writeFileSync(runnerScriptPath, buildPosixRunnerScript(script), 'utf-8')
    if (!nativeWindowsWorktree) {
      chmodSync(runnerScriptPath, 0o755)
    }
  }

  // WSL bash needs Linux spellings for environment paths.
  if (wslWorktree) {
    for (const key of Object.keys(envVars)) {
      envVars[key] = toLinuxPath(envVars[key])
    }
  } else if (nativeWindowsWorktree && runnerShell.family === 'posix') {
    // Convert only path-valued variables to the /c/... form Git Bash uses.
    for (const key of SETUP_RUNNER_PATH_ENV_KEYS) {
      const value = envVars[key]
      if (value) {
        envVars[key] = nativeWindowsPathToPosixShellPath(value)
      }
    }
  }

  return {
    runnerScriptPath,
    envVars,
    // Preserve the typing shell so launch can translate WSL paths and quote for the native terminal.
    ...(launchShell ? { shell: launchShell } : {}),
    ...(waitForAgentStartup === true ? { waitForAgentStartup: true } : {})
  }
}

export function resolveSetupRunnerShell(
  settings: SetupRunnerShellSettings,
  platform: NodeJS.Platform = process.platform,
  options: { resolveGitBashShellPath?: (shell: string) => string | null } = {}
): SetupRunnerShell | undefined {
  if (platform !== 'win32') {
    return undefined
  }

  const terminalWindowsShell = settings?.terminalWindowsShell
  const configuredShell =
    typeof terminalWindowsShell === 'string' && terminalWindowsShell.trim()
      ? terminalWindowsShell.trim()
      : 'powershell.exe'
  const shellBasename = configuredShell.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  const family = resolveWindowsShellStartupFamily(configuredShell)
  if (family === 'posix' && shellBasename !== 'wsl.exe' && shellBasename !== 'wsl') {
    // Match PTY Git Bash resolution; other bash flavors do not use the runner's MSYS /c/... paths.
    const resolveGitBashShellPath =
      options.resolveGitBashShellPath ??
      ((shell: string) => resolveWindowsGitBashShellPath(shell, { platform }))
    if (resolveGitBashShellPath(configuredShell)) {
      // A POSIX terminal can launch bash; each script's shebang still decides its runner format.
      return { family: 'posix' }
    }
  }

  // PowerShell and WSL-as-terminal can invoke existing Windows cmd scripts without changing their syntax.
  return { family: 'cmd' }
}
