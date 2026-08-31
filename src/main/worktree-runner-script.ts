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
  // Why: writing long commands into a runner script avoids the PTY line editor wrapping/truncating them.
  return createWorktreeRunnerScript({
    repo,
    worktreePath,
    script: command,
    runnerBaseName: 'issue-command-runner',
    runtimeTarget: getHookRuntimeTarget(projectRuntime),
    // Why: issue commands share the setup session's shell resolution; the runner still
    // needs its own `#!` line to be treated as bash.
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
  // Why: WSL worktrees are Linux fs even though process.platform is 'win32'; use bash for WSL, .cmd for native Windows.
  const wslWorktree = isWslPath(worktreePath) || Boolean(runtimeTarget?.wslDistro)
  const nativeWindowsWorktree = process.platform === 'win32' && !wslWorktree
  // Why: the terminal-shell preference says nothing about the language a project's script is
  // written in, and every pre-existing Windows script was authored against the cmd runner. Only a
  // `#!` line opts a script into bash, so the same orca.yaml runs identically for every Windows
  // user of the repo instead of following whichever terminal each of them happens to prefer.
  const runnerShell: SetupRunnerShell = nativeWindowsWorktree
    ? setupShell?.family === 'posix' && scriptDeclaresPosixShell(script)
      ? setupShell
      : { family: 'cmd' }
    : { family: 'posix' }
  // Why: `shell` tells the launcher which shell types the command, not which format the runner
  // file is in — the .cmd/.sh extension already carries that. Reporting the runner family here
  // would make a Git Bash pane receive `cmd.exe /c ...`, whose `/c` MSYS rewrites into a drive
  // path (issue #6896), so setup would open an interactive cmd and never run.
  const launchShell: SetupRunnerShell | undefined = nativeWindowsWorktree
    ? (setupShell ?? { family: 'cmd' })
    : process.platform === 'win32' && runtimeTarget?.wslDistro
      ? { family: 'posix', executable: 'wsl.exe' }
      : undefined
  // Why: linked worktrees use a `.git` file, so resolve the real per-worktree gitdir via git rev-parse --git-path.
  const runnerExtension = runnerShell.family === 'cmd' ? 'cmd' : 'sh'
  const gitRelPath = `orca/${runnerBaseName}.${runnerExtension}`
  let runnerScriptPath = getGitPath(worktreePath, gitRelPath, runtimeTarget)

  // Why: git runs inside WSL and returns a Linux path; convert to a UNC path so the Windows fs calls can reach it.
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
      // Why: chmod over a UNC path to the WSL filesystem sets the execute bit correctly inside WSL.
      chmodSync(runnerScriptPath, 0o755)
    }
  }

  // Why: setup script runs inside WSL bash, so translate the Windows UNC env-var paths to Linux paths.
  if (wslWorktree) {
    for (const key of Object.keys(envVars)) {
      envVars[key] = toLinuxPath(envVars[key])
    }
  } else if (nativeWindowsWorktree && runnerShell.family === 'posix') {
    // Why: a Git Bash runner already receives its own path as /c/..., and the shell exports HOME
    // and PWD the same way, so leaving ORCA_* in C:\ form would make them the lone exception.
    // Only path-valued keys convert; the workspace name and policy values are not paths.
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
    // Why: WSL git returns /mnt paths that Node converts back to C:\ for file
    // writes; retain the runtime signal so launch converts them to /mnt again.
    // On native Windows it is the terminal's family, i.e. the shell that types the command.
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
    // Why: the PTY resolves Git Bash independently and falls back to PowerShell when it
    // is missing, so gate the .sh runner on the same resolution. This also keeps
    // non-Git bash flavors (Cygwin's /cygdrive, the System32 WSL shim's /mnt) off the
    // MSYS-only /c/... form the posix runner emits.
    const resolveGitBashShellPath =
      options.resolveGitBashShellPath ??
      ((shell: string) => resolveWindowsGitBashShellPath(shell, { platform }))
    if (resolveGitBashShellPath(configuredShell)) {
      // Note: this reports the terminal's family — the shell that types the launch command, and
      // therefore also that a bash runner *could* launch here. Whether one is written is decided
      // per script by its `#!` line — see docs/reference/windows-setup-shell.md.
      return { family: 'posix' }
    }
  }

  // Why: existing Windows setup scripts were authored for Orca's cmd runner;
  // PowerShell, wsl.exe-as-terminal, and Windows-host projects can invoke it
  // without changing syntax, so they intentionally stay on the cmd runner.
  return { family: 'cmd' }
}
