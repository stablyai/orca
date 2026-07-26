/* eslint-disable max-lines -- Why: hook parsing, layered issue-command resolution, and cross-platform runner setup share one execution surface, so keeping them together avoids subtle drift across create/read/write paths. */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exec, execFile } from 'node:child_process'
import { getDefaultRepoHookSettings } from '../shared/constants'
import { getRuntimePathBasename } from '../shared/cross-platform-path'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import { shouldWaitForSetupBeforeAgentStartup } from '../shared/setup-agent-startup-policy'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../shared/terminal-git-credential-guard'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { gitExecFileSync, promptGuardShellEnv } from './git/runner'
import { isWslPath, parseWslPath, toWindowsWslPath, toLinuxPath } from './wsl'
import { addWorktreeSetupWslInteropEnv } from './pty/wsl-orca-env'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  Repo,
  SetupDecision,
  SetupRunPolicy,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../shared/types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'

const HOOK_TIMEOUT = 120_000 // 2 minutes

export type HookRuntimeTarget = {
  wslDistro?: string | null
}

function getHookShell(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }

  return '/bin/bash'
}

export { parseOrcaYaml }

/**
 * Load hooks from orca.yaml in the given repo root.
 */
export function loadHooks(repoPath: string): OrcaHooks | null {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (!existsSync(yamlPath)) {
    return null
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8')
    return parseOrcaYaml(content)
  } catch {
    return null
  }
}

/**
 * Check whether an orca.yaml exists for a repo.
 */
export function hasHooksFile(repoPath: string): boolean {
  return existsSync(join(repoPath, 'orca.yaml'))
}

// Why: detect unrecognised keys so the UI can suggest an update instead of showing a "could not be parsed" error.
const RECOGNIZED_ORCA_YAML_KEYS = new Set([
  'scripts',
  'issueCommand',
  'defaultTabs',
  'environmentRecipes'
])

/** True when `orca.yaml` has a top-level key this version of Orca does not handle. */
export function hasUnrecognizedOrcaYamlKeys(repoPath: string): boolean {
  try {
    const content = readFileSync(join(repoPath, 'orca.yaml'), 'utf-8')
    for (const line of iterateLfScriptLines(content)) {
      // Why: match bare `key:` at end-of-line too, since a mapping with a block value on the next line is valid YAML.
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
      if (m != null && !RECOGNIZED_ORCA_YAML_KEYS.has(m[1])) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

// ─── Issue command files ────────────────────────────────────────────────
// Why: `.orca/issue-command` is the per-user override; `orca.yaml` is the tracked project default.

const ORCA_DIR = '.orca'
const ISSUE_COMMAND_FILENAME = 'issue-command'

export function getIssueCommandFilePath(repoPath: string): string {
  return join(repoPath, ORCA_DIR, ISSUE_COMMAND_FILENAME)
}

export function getSharedIssueCommand(repoPath: string): string | null {
  return loadHooks(repoPath)?.issueCommand?.trim() || null
}

export type ResolvedIssueCommand = {
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/**
 * Resolve the GitHub issue command using local override first, then tracked repo config.
 */
export function readIssueCommand(repoPath: string): ResolvedIssueCommand {
  const filePath = getIssueCommandFilePath(repoPath)
  let localContent: string | null = null

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      localContent = content || null
    } catch {
      localContent = null
    }
  }

  const sharedContent = getSharedIssueCommand(repoPath)
  const effectiveContent = localContent ?? sharedContent

  return {
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath: filePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

/**
 * Write the per-user issue command override to `{repoRoot}/.orca/issue-command`.
 * Empty content deletes the override so the shared `orca.yaml` command applies again.
 */
export function writeIssueCommand(repoPath: string, content: string): void {
  const filePath = getIssueCommandFilePath(repoPath)
  const trimmed = content.trim()

  try {
    if (!trimmed) {
      rmSync(filePath, { force: true })
      return
    }

    const orcaDir = join(repoPath, ORCA_DIR)
    if (!existsSync(orcaDir)) {
      mkdirSync(orcaDir, { recursive: true })
    }
    ensureOrcaDirIgnored(repoPath)
    writeFileSync(filePath, `${trimmed}\n`, 'utf-8')
  } catch (err) {
    console.error('[hooks] Failed to write issue command:', err)
    // Why: re-throw so the IPC handler surfaces the write failure to the renderer's .catch().
    throw err
  }
}

/** Ensure `.orca` is in `.gitignore` so the per-user directory is never committed. */
function ensureOrcaDirIgnored(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore')
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (/^\.orca\/?$/m.test(content)) {
        return
      }
      const separator = content.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, `${content}${separator}.orca\n`, 'utf-8')
    } else {
      writeFileSync(gitignorePath, '.orca\n', 'utf-8')
    }
  } catch {
    console.warn('[hooks] Could not update .gitignore to exclude .orca')
  }
}

function getEffectiveHookScript(
  yamlScript: string | undefined,
  localScript: string | undefined,
  policy: HookCommandSourcePolicy
): string | undefined {
  const shared = yamlScript?.trim()
  const local = localScript?.trim()

  if (policy === 'local-only') {
    return local || undefined
  }

  if (policy === 'run-both') {
    return [shared, local].filter(Boolean).join('\n') || undefined
  }

  return shared || undefined
}

export function getEffectiveHooksFromConfig(
  repo: Repo,
  yamlHooks: OrcaHooks | null
): OrcaHooks | null {
  const localSetup = repo.hookSettings?.scripts.setup
  const localArchive = repo.hookSettings?.scripts.archive
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const setupPolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup?.trim())
  })
  const archivePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localArchive?.trim())
  })
  const setup = getEffectiveHookScript(yamlHooks?.scripts.setup, localSetup, setupPolicy)
  const archive = getEffectiveHookScript(yamlHooks?.scripts.archive, localArchive, archivePolicy)

  if (!setup && !archive) {
    return null
  }

  // Why: committed `orca.yaml` and local Settings can coexist; the source policy decides which is authoritative.
  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    }
  }
}

export function getEffectiveHooks(repo: Repo, worktreePath?: string): OrcaHooks | null {
  const hooksRoot = worktreePath ?? repo.path
  return getEffectiveHooksFromConfig(repo, loadHooks(hooksRoot))
}

export function getEffectiveSetupRunPolicy(repo: Repo): SetupRunPolicy {
  return repo.hookSettings?.setupRunPolicy ?? getDefaultRepoHookSettings().setupRunPolicy!
}

export function shouldRunSetupForCreate(repo: Repo, decision: SetupDecision = 'inherit'): boolean {
  if (decision === 'run') {
    return true
  }
  if (decision === 'skip') {
    return false
  }

  const policy = getEffectiveSetupRunPolicy(repo)
  if (policy === 'ask') {
    throw new Error('Setup decision required for this repository')
  }

  return policy === 'run-by-default'
}

export function getDefaultTabCommandTrustContent(hooks: OrcaHooks | null): string {
  const commands = (hooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      if (!command) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${command}`
    })
    .filter((entry): entry is string => entry !== null)
  return [hooks?.scripts.setup?.trim(), ...commands].filter(Boolean).join('\n\n')
}

export function getDefaultTabsLaunch(
  hooks: OrcaHooks | null,
  repo: Repo,
  decision: SetupDecision = 'inherit'
): WorktreeDefaultTabsLaunch | undefined {
  const tabs = hooks?.defaultTabs ?? []
  if (tabs.length === 0) {
    return undefined
  }
  const hasCommands = tabs.some((tab) => Boolean(tab.command?.trim()))
  const sharedCommandPolicy = resolveHookCommandSourcePolicy(
    repo.hookSettings?.commandSourcePolicy,
    {
      hasLocalScript: Boolean(repo.hookSettings?.scripts.setup?.trim())
    }
  )
  // Why: local-only repos may use shared tab titles/colors but must not run the committed orca.yaml commands.
  const canRunSharedCommands = sharedCommandPolicy !== 'local-only'
  const runCommands =
    hasCommands && canRunSharedCommands ? shouldRunSetupForCreate(repo, decision) : false
  return { tabs, runCommands }
}

export function getSetupCommandSource(
  repo: Repo,
  worktreePath?: string
): { source: 'yaml' | 'local' | 'both'; command: string } | null {
  const hooksRoot = worktreePath ?? repo.path
  const yamlHooks = loadHooks(hooksRoot)
  const yamlSetup = yamlHooks?.scripts.setup?.trim()
  const localSetup = repo.hookSettings?.scripts.setup?.trim()
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const policy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (policy === 'local-only') {
    return localSetup ? { source: 'local', command: localSetup } : null
  }

  if (policy === 'run-both' && yamlSetup && localSetup) {
    return { source: 'both', command: `${yamlSetup}\n${localSetup}` }
  }

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }

  return null
}

function getSetupEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    ORCA_WORKSPACE_NAME: getRuntimePathBasename(worktreePath),
    // Compat with conductor.json users
    CONDUCTOR_ROOT_PATH: repo.path,
    GHOSTX_ROOT_PATH: repo.path
  }
}

function getGitPath(cwd: string, relativePath: string, runtimeTarget?: HookRuntimeTarget): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd,
    ...(runtimeTarget?.wslDistro ? { wslDistro: runtimeTarget.wslDistro } : {})
  }).trim()
}

function getHookRuntimeTarget(
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget
): HookRuntimeTarget | undefined {
  if (!projectRuntime) {
    return undefined
  }

  if ('status' in projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return projectRuntime.repair.preferredRuntime.kind === 'wsl'
        ? { wslDistro: projectRuntime.repair.preferredRuntime.distro }
        : undefined
    }
    return projectRuntime.runtime.kind === 'wsl'
      ? { wslDistro: projectRuntime.runtime.distro }
      : undefined
  }

  return projectRuntime.wslDistro ? { wslDistro: projectRuntime.wslDistro } : undefined
}

function getHookWslContext(
  cwd: string,
  runtimeTarget?: HookRuntimeTarget
): { distro: string | null; linuxPath: string } | null {
  const pathInfo = parseWslPath(cwd)
  if (pathInfo) {
    return pathInfo
  }

  const wslDistro = runtimeTarget?.wslDistro?.trim()
  if (!wslDistro) {
    return null
  }

  // Why: project runtime can route a Windows checkout through WSL, so hooks need the Linux view of the path.
  return {
    distro: wslDistro,
    linuxPath: toLinuxPath(cwd)
  }
}

export function buildWindowsRunnerScript(script: string): string {
  let runnerScript = '@echo off\r\nsetlocal EnableExtensions\r\n'

  for (const rawLine of iterateLfScriptLines(script)) {
    const command = rawLine.trim()
    if (!command) {
      runnerScript += '\r\n'
      continue
    }

    // Why: npm/pnpm are Windows batch files; `call` each line and bail on errorlevel for set -e fail-fast behavior.
    runnerScript += `call ${command}\r\nif errorlevel 1 exit /b %errorlevel%\r\n`
  }

  return runnerScript
}

function* iterateLfScriptLines(script: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < script.length; index++) {
    if (script.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && script.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield script.slice(lineStart, lineEnd)
    lineStart = index + 1
  }

  if (lineStart <= script.length) {
    yield script.slice(lineStart)
  }
}

export function createSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget
): WorktreeSetupLaunch {
  return createWorktreeRunnerScript(
    repo,
    worktreePath,
    script,
    'setup-runner',
    getHookRuntimeTarget(projectRuntime),
    shouldWaitForSetupBeforeAgentStartup(repo.hookSettings?.setupAgentStartupPolicy)
  )
}

export function getSetupRunnerEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ...getSetupEnvVars(repo, worktreePath),
    // Why: the Setup terminal is unattended automation, so force the credential guard regardless of user opt-out.
    [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
  }
}

export function buildPosixRunnerScript(script: string): string {
  return `#!/usr/bin/env bash\nset -e\n${normalizeCrlfScriptLineEndings(script)}\n`
}

function normalizeCrlfScriptLineEndings(script: string): string {
  let crlfStart = script.indexOf('\r\n')
  if (crlfStart === -1) {
    return script
  }

  let normalized = script.slice(0, crlfStart)
  let chunkStart = crlfStart + 2
  normalized += '\n'
  crlfStart = script.indexOf('\r\n', chunkStart)

  while (crlfStart !== -1) {
    normalized += script.slice(chunkStart, crlfStart)
    normalized += '\n'
    chunkStart = crlfStart + 2
    crlfStart = script.indexOf('\r\n', chunkStart)
  }

  return `${normalized}${script.slice(chunkStart)}`
}

export function createIssueCommandRunnerScript(
  repo: Repo,
  worktreePath: string,
  command: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget
): WorktreeSetupLaunch {
  // Why: writing long commands into a runner script avoids the PTY line editor wrapping/truncating them.
  return createWorktreeRunnerScript(
    repo,
    worktreePath,
    command,
    'issue-command-runner',
    getHookRuntimeTarget(projectRuntime)
  )
}

function createWorktreeRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  runnerBaseName: 'setup-runner' | 'issue-command-runner',
  runtimeTarget?: HookRuntimeTarget,
  waitForAgentStartup?: boolean
): WorktreeSetupLaunch {
  const envVars = getSetupRunnerEnvVars(repo, worktreePath)
  // Why: WSL worktrees are Linux fs even though process.platform is 'win32'; use bash for WSL, .cmd for native Windows.
  const wslWorktree = isWslPath(worktreePath) || Boolean(runtimeTarget?.wslDistro)
  const useWindowsFormat = process.platform === 'win32' && !wslWorktree
  // Why: linked worktrees use a `.git` file, so resolve the real per-worktree gitdir via git rev-parse --git-path.
  const gitRelPath = useWindowsFormat ? `orca/${runnerBaseName}.cmd` : `orca/${runnerBaseName}.sh`
  let runnerScriptPath = getGitPath(worktreePath, gitRelPath, runtimeTarget)

  // Why: git runs inside WSL and returns a Linux path; convert to a UNC path so the Windows fs calls can reach it.
  if (wslWorktree) {
    const wslInfo = getHookWslContext(worktreePath, runtimeTarget)
    if (wslInfo?.distro) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }

  mkdirSync(dirname(runnerScriptPath), { recursive: true })

  if (useWindowsFormat) {
    writeFileSync(runnerScriptPath, buildWindowsRunnerScript(script), 'utf-8')
  } else {
    writeFileSync(runnerScriptPath, buildPosixRunnerScript(script), 'utf-8')
    // Why: chmod over a UNC path to the WSL filesystem sets the execute bit correctly inside WSL.
    chmodSync(runnerScriptPath, 0o755)
  }

  // Why: setup script runs inside WSL bash, so translate the Windows UNC env-var paths to Linux paths.
  if (wslWorktree) {
    for (const key of Object.keys(envVars)) {
      envVars[key] = toLinuxPath(envVars[key])
    }
  }

  return {
    runnerScriptPath,
    envVars,
    ...(waitForAgentStartup === true ? { waitForAgentStartup: true } : {})
  }
}

/**
 * Run a named hook script in the given working directory.
 */
export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo,
  hooksPath?: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget
): Promise<{ success: boolean; output: string }> {
  const hooks = getEffectiveHooks(repo, hooksPath)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  const runtimeTarget = getHookRuntimeTarget(projectRuntime)
  const wslInfo = getHookWslContext(cwd, runtimeTarget)

  if (wslInfo) {
    // Why: use execFile to bypass cmd.exe, which mangles single-quote escaping of %, ^, &, |, etc.
    const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
    const escapedScript = script.replace(/'/g, "'\\''")
    const bashCmd = `cd '${escapedCwd}' && ${escapedScript}`
    // Why: hook scripts run inside WSL, so translate the ORCA_* Windows UNC paths to Linux paths.
    const envVars = getSetupEnvVars(repo, cwd)
    const wslEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(envVars)) {
      wslEnv[key] = toLinuxPath(value)
    }
    const hookEnv: NodeJS.ProcessEnv = { ...process.env, ...wslEnv }
    // Why: wsl.exe only imports Windows env vars named in WSLENV; without
    // registering them the setup vars never reach the guest (#9206).
    addWorktreeSetupWslInteropEnv(hookEnv)

    return new Promise((resolve) => {
      let child: ReturnType<typeof execFile> | null = null
      let settled = false

      const finish = (error: Error | null, stdout = '', stderr = ''): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (error) {
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, error.message)
          resolve({
            success: false,
            output: `${stdout}\n${stderr}\n${error.message}`.trim()
          })
        } else {
          console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
          resolve({
            success: true,
            output: `${stdout}\n${stderr}`.trim()
          })
        }
      }

      // Why: execFile's timeout only signals wsl.exe; force-unblock after HOOK_TIMEOUT if no callback arrives.
      const timeout = setTimeout(() => {
        child?.kill()
        finish(new Error(`Hook timed out after ${HOOK_TIMEOUT}ms.`))
      }, HOOK_TIMEOUT)

      try {
        const distroArgs = wslInfo.distro ? ['-d', wslInfo.distro] : []
        child = execFile(
          'wsl.exe',
          [...distroArgs, '--', 'bash', '-c', bashCmd],
          {
            timeout: HOOK_TIMEOUT,
            encoding: 'utf-8',
            // Why: same unattended-git guard as the non-WSL branch below
            // (issue #7652) — WSL repos are the likeliest to hit the GCM
            // popup, and the guard's WSLENV registration is what carries it
            // across the wsl.exe boundary. Wrap hookEnv (not a fresh env) so
            // the setup-var WSLENV entries registered above (#9206) are kept —
            // promptGuardShellEnv appends its own keys to the existing WSLENV.
            env: promptGuardShellEnv(hookEnv)
          },
          (error, stdout, stderr) => {
            finish(error ?? null, stdout, stderr)
          }
        )
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return new Promise((resolve) => {
    exec(
      script,
      {
        cwd,
        timeout: HOOK_TIMEOUT,
        shell: getHookShell(),
        // Why: hooks run unattended; block Git Credential Manager's interactive prompt while keeping cached auth (issue #7652).
        env: promptGuardShellEnv({
          ...process.env,
          ...getSetupEnvVars(repo, cwd)
        })
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, error.message)
          resolve({
            success: false,
            output: `${stdout}\n${stderr}\n${error.message}`.trim()
          })
        } else {
          console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
          resolve({
            success: true,
            output: `${stdout}\n${stderr}`.trim()
          })
        }
      }
    )
  })
}
