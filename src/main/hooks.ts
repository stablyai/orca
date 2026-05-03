/* eslint-disable max-lines -- Why: hook parsing, layered issue-command resolution, and cross-platform runner setup share one execution surface, so keeping them together avoids subtle drift across create/read/write paths. */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { exec, execFile } from 'child_process'
import { getDefaultRepoHookSettings } from '../shared/constants'
import { gitExecFileSync } from './git/runner'
import { isWslPath, parseWslPath, toWindowsWslPath, toLinuxPath } from './wsl'
import type {
  OrcaHooks,
  Repo,
  SetupDecision,
  SetupRunPolicy,
  WorktreeSetupLaunch
} from '../shared/types'

const HOOK_TIMEOUT = 120_000 // 2 minutes

function getHookShell(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }

  return '/bin/bash'
}

/**
 * Parse a simple orca.yaml file. Handles only the supported `scripts:` and
 * `issueCommand:` keys with multiline string values (YAML block scalar `|`).
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  const hooks: OrcaHooks = { scripts: {} }
  const lines = content.split(/\r?\n/)

  let currentSection: 'scripts' | 'issueCommand' | null = null
  let currentKey: 'setup' | 'archive' | null = null
  let issueCommandValue = ''

  for (const line of lines) {
    const topLevelKeyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\|)?\s*(.*)$/)
    if (topLevelKeyMatch) {
      if (currentSection === 'scripts' && currentKey) {
        hooks.scripts[currentKey] = issueCommandValue.trimEnd()
      } else if (currentSection === 'issueCommand') {
        hooks.issueCommand = issueCommandValue.trimEnd() || undefined
      }

      const [, key, blockScalar, rest] = topLevelKeyMatch
      currentKey = null
      issueCommandValue = ''

      if (key === 'scripts') {
        currentSection = 'scripts'
        continue
      }

      if (key === 'issueCommand') {
        currentSection = 'issueCommand'
        if (blockScalar) {
          continue
        }
        hooks.issueCommand = rest.trim() || undefined
        currentSection = null
        continue
      }

      currentSection = null
      continue
    }

    if (currentSection === 'scripts') {
      // Indented key like "  setup: |" or "  archive: |" or "  setup: echo hello"
      const keyMatch = line.match(/^  (setup|archive):\s*(\|)?\s*(.*)$/)
      if (keyMatch) {
        // Save previous key
        if (currentKey) {
          hooks.scripts[currentKey] = issueCommandValue.trimEnd()
        }
        currentKey = keyMatch[1] as 'setup' | 'archive'
        issueCommandValue = keyMatch[3] ? `${keyMatch[3]}\n` : ''
        continue
      }

      // Content line (indented by 4+ spaces under a key)
      if (currentKey && line.startsWith('    ')) {
        issueCommandValue += `${line.slice(4)}\n`
      }
      continue
    }

    if (currentSection === 'issueCommand' && line.startsWith('  ')) {
      // Why: `issueCommand` is a top-level scalar in `orca.yaml`, so its block
      // content must stay separate from the `scripts:` parser rather than being
      // shoehorned into that section's indentation rules.
      issueCommandValue += `${line.slice(2)}\n`
    }
  }

  if (currentSection === 'scripts' && currentKey) {
    hooks.scripts[currentKey] = issueCommandValue.trimEnd()
  } else if (currentSection === 'issueCommand') {
    hooks.issueCommand = issueCommandValue.trimEnd() || undefined
  }

  if (!hooks.scripts.setup && !hooks.scripts.archive && !hooks.issueCommand) {
    return null
  }
  return hooks
}

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

// Why: when a newer Orca release adds a top-level key to `orca.yaml` (like
// `issueCommand` was added here), older versions that don't recognise it will
// return `null` from `parseOrcaYaml` and show a confusing "could not be parsed"
// error.  Detecting well-formed but unrecognised keys lets the UI suggest an
// update instead of implying the file is broken.
const RECOGNIZED_ORCA_YAML_KEYS = new Set(['scripts', 'issueCommand'])

/**
 * Return true when `orca.yaml` contains at least one top-level key that this
 * version of Orca does not handle.
 */
export function hasUnrecognizedOrcaYamlKeys(repoPath: string): boolean {
  try {
    const content = readFileSync(join(repoPath, 'orca.yaml'), 'utf-8')
    return content.split(/\r?\n/).some((line) => {
      // Why: bare `key:` at end-of-line (no trailing space) is valid YAML for
      // a mapping with a block value on the next line. Match both forms so
      // newer keys like `futureFeature:\n  nested` are still detected.
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
      return m != null && !RECOGNIZED_ORCA_YAML_KEYS.has(m[1])
    })
  } catch {
    return false
  }
}

// ─── Issue command files ────────────────────────────────────────────────
// Why: `orca.yaml` is the tracked, project-wide defaults surface, while
// `.orca/issue-command` remains the per-user override. Keeping the local file in
// `.orca/` lets users customize agent automation without editing committed config.

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
 * Creates `.orca/` and ensures it is in `.gitignore` on first write.
 * If content is empty, deletes only the override so the shared `orca.yaml`
 * command becomes effective again.
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
    // Why: re-throw so the error propagates through the IPC handler to the
    // renderer, which already has .catch() ready to surface write failures.
    throw err
  }
}

/**
 * Ensure `.orca` is listed in the repo's `.gitignore` so the per-user
 * directory is never accidentally committed.
 */
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

export function getEffectiveHooks(repo: Repo, worktreePath?: string): OrcaHooks | null {
  const yamlHooks = loadHooks(worktreePath ?? repo.path)
  const legacySetup = repo.hookSettings?.scripts.setup?.trim()
  const legacyArchive = repo.hookSettings?.scripts.archive?.trim()
  const setup = yamlHooks?.scripts.setup?.trim() || legacySetup
  const archive = yamlHooks?.scripts.archive?.trim() || legacyArchive

  if (!setup && !archive) {
    return null
  }

  // Why: `orca.yaml` is the preferred source going forward, but existing users may
  // still have setup/archive commands persisted only in repo settings. Resolve each
  // hook independently so a repo that has only migrated one command into `orca.yaml`
  // does not silently lose the other legacy hook until the migration is complete.
  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    }
  }
}

export function setupScriptsMatch(
  repo: Repo,
  worktreePath: string,
  primarySetupScript = getEffectiveHooks(repo)?.scripts.setup
): boolean {
  const worktreeSetupScript = getEffectiveHooks(repo, worktreePath)?.scripts.setup
  return primarySetupScript === worktreeSetupScript
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

export function getSetupCommandSource(
  repo: Repo,
  worktreePath?: string
): { source: 'yaml'; command: string } | null {
  const yamlSetup = loadHooks(worktreePath ?? repo.path)?.scripts.setup?.trim()

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }

  return null
}

function getSetupEnvVars(repo: Repo, worktreePath: string): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    // Compat with conductor.json users
    CONDUCTOR_ROOT_PATH: repo.path,
    GHOSTX_ROOT_PATH: repo.path
  }
}

function getGitPath(cwd: string, relativePath: string): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd
  }).trim()
}

function buildWindowsRunnerScript(script: string): string {
  const lines = script.replace(/\r?\n/g, '\n').split('\n')
  const runnerLines = ['@echo off', 'setlocal EnableExtensions']

  for (const rawLine of lines) {
    const command = rawLine.trim()
    if (!command) {
      runnerLines.push('')
      continue
    }

    // Why: setup commands often invoke `npm`/`pnpm`, which are batch files on
    // Windows. Calling one batch file from another without `call` never returns
    // to later lines, and plain newline-separated commands also keep running
    // after failures. Wrap each line in `call` and bail on non-zero exit codes
    // so the generated runner matches the fail-fast behavior of `set -e`.
    runnerLines.push(`call ${command}`)
    runnerLines.push('if errorlevel 1 exit /b %errorlevel%')
  }

  return `${runnerLines.join('\r\n')}\r\n`
}

export function createSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string
): WorktreeSetupLaunch {
  return createWorktreeRunnerScript(repo, worktreePath, script, 'setup-runner')
}

export function createIssueCommandRunnerScript(
  repo: Repo,
  worktreePath: string,
  command: string
): WorktreeSetupLaunch {
  // Why: long issue-automation commands are user-visible shell input when
  // written directly to the PTY, so terminal line editors can wrap or truncate
  // them before execution. Writing the real command into a runner script keeps
  // the shell startup path short and mirrors the already-stable setup runner
  // flow instead of inventing a second launch mechanism.
  return createWorktreeRunnerScript(repo, worktreePath, command, 'issue-command-runner')
}

function createWorktreeRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  runnerBaseName: 'setup-runner' | 'issue-command-runner'
): WorktreeSetupLaunch {
  const envVars = getSetupEnvVars(repo, worktreePath)
  // Why: WSL worktrees run on a Linux filesystem even though process.platform
  // is 'win32'. Use bash scripts for WSL, .cmd for native Windows.
  const wslWorktree = isWslPath(worktreePath)
  const useWindowsFormat = process.platform === 'win32' && !wslWorktree
  const normalizedScript = useWindowsFormat
    ? script.replace(/\r?\n/g, '\r\n')
    : script.replace(/\r\n/g, '\n')
  // Why: linked git worktrees use a `.git` file that points at the real gitdir,
  // so writing under `${worktreePath}/.git/...` fails. `git rev-parse --git-path`
  // resolves the actual per-worktree git storage path safely across platforms.
  const gitRelPath = useWindowsFormat ? `orca/${runnerBaseName}.cmd` : `orca/${runnerBaseName}.sh`
  let runnerScriptPath = getGitPath(worktreePath, gitRelPath)

  // Why: for WSL worktrees, getGitPath returns a Linux path (e.g. /home/user/...)
  // because git runs inside WSL. Convert it to a Windows UNC path so mkdirSync
  // and writeFileSync (which run on Windows) can access it.
  if (wslWorktree) {
    const wslInfo = parseWslPath(worktreePath)
    if (wslInfo) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }

  mkdirSync(dirname(runnerScriptPath), { recursive: true })

  if (useWindowsFormat) {
    writeFileSync(runnerScriptPath, buildWindowsRunnerScript(normalizedScript), 'utf-8')
  } else {
    writeFileSync(runnerScriptPath, `#!/usr/bin/env bash\nset -e\n${normalizedScript}\n`, 'utf-8')
    // Why: chmod via UNC paths to WSL filesystem is supported by Windows and
    // sets the execute bit correctly inside WSL.
    chmodSync(runnerScriptPath, 0o755)
  }

  // Why: when the worktree is on WSL, env vars like ORCA_ROOT_PATH and
  // ORCA_WORKTREE_PATH contain Windows UNC paths. The setup script runs
  // inside WSL bash, so translate them to Linux paths.
  if (wslWorktree) {
    for (const key of Object.keys(envVars)) {
      envVars[key] = toLinuxPath(envVars[key])
    }
  }

  return { runnerScriptPath, envVars }
}

/**
 * Run a named hook script in the given working directory.
 */
export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo,
  hooksPath?: string
): Promise<{ success: boolean; output: string }> {
  const hooks = getEffectiveHooks(repo, hooksPath)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  const wslInfo = parseWslPath(cwd)

  if (wslInfo) {
    // Why: use execFile('wsl.exe', [...]) instead of exec() to bypass the
    // Windows shell (cmd.exe). exec() always routes through a shell, and
    // cmd.exe doesn't understand single-quote escaping — it would mangle
    // paths/scripts containing %, ^, &, |, etc.
    const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
    const escapedScript = script.replace(/'/g, "'\\''")
    const bashCmd = `cd '${escapedCwd}' && ${escapedScript}`
    // Why: translate ORCA_ROOT_PATH / ORCA_WORKTREE_PATH to Linux paths so
    // hook scripts that reference $ORCA_WORKTREE_PATH get usable paths
    // inside WSL, not Windows UNC paths.
    const envVars = getSetupEnvVars(repo, cwd)
    const wslEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(envVars)) {
      wslEnv[key] = toLinuxPath(value)
    }

    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        ['-d', wslInfo.distro, '--', 'bash', '-c', bashCmd],
        {
          timeout: HOOK_TIMEOUT,
          encoding: 'utf-8',
          env: { ...process.env, ...wslEnv }
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

  return new Promise((resolve) => {
    exec(
      script,
      {
        cwd,
        timeout: HOOK_TIMEOUT,
        shell: getHookShell(),
        env: {
          ...process.env,
          ...getSetupEnvVars(repo, cwd)
        }
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
