import { mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, posix as posixPath, win32 as win32Path } from 'node:path'
import { shouldWaitForSetupBeforeAgentStartup } from '../shared/setup-agent-startup-policy'
import { nativeWindowsPathToPosixShellPath } from '../shared/setup-runner-command'
import { scriptDeclaresPosixShell } from '../shared/setup-script-shebang'
import { resolveWindowsShellStartupFamily } from '../shared/windows-terminal-shell'
import { resolveWindowsGitBashShellPath } from './git-bash'
import { gitExecFileSync } from './git/runner'
import { isLocalGitRuntimeRouterInstalled } from './git/command-runner/local-git-runtime-route'
import { readWorktreeGitPath } from './git/worktree-git-path'
import { knownWslAutomountRoots } from './wsl/wsl-automount-root'
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

let runnerTmpSequence = 0

function getGitPath(cwd: string, relativePath: string): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd,
    // Host Git on purpose: a read-only path lookup, kept off a synchronous wsl.exe.
    hostGit: true
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

function createWorktreeRunnerScript(args: {
  repo: Repo
  worktreePath: string
  script: string
  runnerBaseName: 'setup-runner'
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
  // With the D1c Git router, read the link: if WSL Git made the worktree, host Git can't.
  const fromLink = isLocalGitRuntimeRouterInstalled()
    ? readWorktreeGitPath(worktreePath, gitRelPath, knownWslAutomountRoots())
    : null
  let runnerScriptPath = fromLink ?? getGitPath(worktreePath, gitRelPath)

  // A main worktree's --git-path is worktree-relative. fs calls must not resolve it from the app cwd.
  // win32.isAbsolute also treats rooted Linux paths from git-in-WSL as absolute.
  const isPathAbsolute = process.platform === 'win32' ? win32Path.isAbsolute : posixPath.isAbsolute
  if (!isPathAbsolute(runnerScriptPath)) {
    runnerScriptPath = join(worktreePath, runnerScriptPath)
  }

  // Convert WSL Git's Linux path to a path Windows filesystem calls can reach.
  if (wslWorktree && !fromLink) {
    const wslInfo = getHookWslContext(worktreePath, runtimeTarget)
    if (wslInfo?.distro && runnerScriptPath.startsWith('/')) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }

  mkdirSync(dirname(runnerScriptPath), { recursive: true })

  const runnerContent =
    runnerShell.family === 'cmd' ? buildWindowsRunnerScript(script) : buildPosixRunnerScript(script)
  // A manual re-run can overwrite a script bash is still reading by byte offset.
  // rename swaps the inode so the running shell keeps its own copy.
  // The suffix is per-call so overlapping preparations do not share one tmp file.
  const tmpRunnerPath = `${runnerScriptPath}.tmp-${process.pid}-${++runnerTmpSequence}`
  try {
    writeFileSync(tmpRunnerPath, runnerContent, 'utf-8')
    if (runnerShell.family !== 'cmd' && !nativeWindowsWorktree) {
      chmodSync(tmpRunnerPath, 0o755)
    }
    renameSync(tmpRunnerPath, runnerScriptPath)
  } catch {
    try {
      // Windows can refuse to replace a runner cmd.exe still holds open. The mode
      // stays 0644 here, which is fine only while consumers run `bash <path>`.
      writeFileSync(runnerScriptPath, runnerContent, 'utf-8')
    } finally {
      rmSync(tmpRunnerPath, { force: true })
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
