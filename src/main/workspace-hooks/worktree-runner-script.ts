import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { shouldWaitForSetupBeforeAgentStartup } from '../../shared/agent-launch/startup/setup-agent-startup-policy'
import {
  nativeWindowsPathToPosixShellPath,
  type SetupRunnerShell
} from '../../shared/agent-launch/startup/setup-runner-command'
import { scriptDeclaresPosixShell } from '../../shared/workspace-setup/setup-script-shebang'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import { resolveWindowsGitBashShellPath } from '../pty/shell-startup/git-bash'
import { gitExecFileSync } from '../git/command-runner/git-exec-file-sync'
import { isLocalGitRuntimeRouterInstalled } from '../git/command-runner/local-git-runtime-route'
import { readWorktreeGitPath } from '../git/worktrees/catalog/worktree-git-path'
import { resolveWslWorktreeGitPath } from '../git/worktrees/catalog/wsl-worktree-git-path'
import { knownWslAutomountRoots } from '../wsl/filesystem/wsl-automount-root'
import { isWslPath } from '../wsl/filesystem/unc-path-access'
import { windowsFsPath } from '../wsl/filesystem/wsl-unc-drive-fs-path'
import { toWindowsWslPath, toLinuxPath } from '../../shared/wsl-paths'
import {
  getHookRuntimeTarget,
  getHookWslContext,
  type HookRuntimeTarget
} from './hook-runtime-target'
import {
  SETUP_RUNNER_PATH_ENV_KEYS,
  getSetupRunnerEnvVars,
  type HookWorkspaceIdentity
} from './setup-hook-env-vars'
import { ignoreFolderSetupRunners, newFolderSetupRunnerPath } from './folder-setup-runner-files'
import { isFolderRepo } from '../../shared/repo-kind'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from './setup-runner-script-text'

import type { Repo } from '../../shared/repo-types'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type { SetupAgentStartupPolicy } from '../../shared/orca-yaml-hook-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/execution-host/project-execution-runtime'

type SetupRunnerShellSettings = Record<string, unknown> | undefined

function getGitPath(cwd: string, relativePath: string): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd,
    // Host Git on purpose: a read-only path lookup, kept off a synchronous wsl.exe.
    hostGit: true
  }).trim()
}

export async function createSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  setupShell?: SetupRunnerShell,
  projectStartupPolicy?: SetupAgentStartupPolicy,
  identity?: HookWorkspaceIdentity
): Promise<WorktreeSetupLaunch> {
  return createWorktreeRunnerScript({
    identity,
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

async function createWorktreeRunnerScript(args: {
  repo: Repo
  worktreePath: string
  script: string
  runnerBaseName: 'setup-runner'
  runtimeTarget?: HookRuntimeTarget
  waitForAgentStartup?: boolean
  setupShell?: SetupRunnerShell
  identity?: HookWorkspaceIdentity
}): Promise<WorktreeSetupLaunch> {
  const {
    repo,
    worktreePath,
    script,
    runnerBaseName,
    runtimeTarget,
    waitForAgentStartup,
    setupShell,
    identity
  } = args
  const envVars = getSetupRunnerEnvVars(repo, worktreePath, identity)
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
  const runnerExtension = runnerShell.family === 'cmd' ? 'cmd' : 'sh'
  const runnerScriptPath = isFolderRepo(repo)
    ? newFolderSetupRunnerPath(
        worktreePath,
        requireFolderIdentity(identity).worktreeId,
        runnerExtension
      )
    : await resolveGitRunnerScriptPath(worktreePath, runnerBaseName, runnerExtension, runtimeTarget)

  // Write through the drive path when WSL refuses its drive mounts over UNC; launch keeps the UNC spelling.
  const runnerFsPath = windowsFsPath(runnerScriptPath)
  await mkdir(dirname(runnerFsPath), { recursive: true })
  if (isFolderRepo(repo)) {
    await ignoreFolderSetupRunners(dirname(dirname(runnerFsPath)))
  }

  if (runnerShell.family === 'cmd') {
    await writeFile(runnerFsPath, buildWindowsRunnerScript(script), 'utf-8')
  } else {
    await writeFile(runnerFsPath, buildPosixRunnerScript(script), 'utf-8')
    if (!nativeWindowsWorktree) {
      await chmod(runnerFsPath, 0o755)
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

function requireFolderIdentity(identity: HookWorkspaceIdentity | undefined): HookWorkspaceIdentity {
  if (!identity) {
    throw new Error('A folder workspace setup runner needs the workspace it runs for.')
  }
  return identity
}

async function resolveGitRunnerScriptPath(
  worktreePath: string,
  runnerBaseName: 'setup-runner',
  runnerExtension: 'sh' | 'cmd',
  runtimeTarget: HookRuntimeTarget | undefined
): Promise<string> {
  const wslWorktree = isWslPath(worktreePath) || Boolean(runtimeTarget?.wslDistro)
  // Linked worktrees have .git files; resolve the per-worktree gitdir through Git.
  const gitRelPath = `orca/${runnerBaseName}.${runnerExtension}`
  // Read the link with the D1c Git router (if WSL Git made the worktree, host Git can't). A worktree
  // inside a distro never runs synchronous Git: that would be a synchronous wsl.exe on the main thread.
  const fromLink = isWslPath(worktreePath)
    ? await resolveWslWorktreeGitPath(worktreePath, gitRelPath)
    : isLocalGitRuntimeRouterInstalled()
      ? readWorktreeGitPath(worktreePath, gitRelPath, knownWslAutomountRoots())
      : null
  let runnerScriptPath = fromLink ?? getGitPath(worktreePath, gitRelPath)

  // Convert WSL Git's Linux path to a path Windows filesystem calls can reach.
  if (wslWorktree && !fromLink) {
    const wslInfo = getHookWslContext(worktreePath, runtimeTarget)
    if (wslInfo?.distro) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }
  return runnerScriptPath
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
