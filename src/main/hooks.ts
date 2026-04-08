import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
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
 * Parse a simple orca.yaml file. Handles only the `scripts:` block with
 * multiline string values (YAML block scalar `|`).
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  const hooks: OrcaHooks = { scripts: {} }

  // Match top-level "scripts:" block
  const scriptsMatch = content.match(/^scripts:\s*$/m)
  if (!scriptsMatch) {
    return null
  }

  const afterScripts = content.slice(scriptsMatch.index! + scriptsMatch[0].length)
  // [Fix]: Split using /\r?\n/ instead of '\n'. Otherwise, on Windows, trailing \r characters
  // stay attached to script commands, which causes fatal '\r command not found' errors in WSL/bash.
  const lines = afterScripts.split(/\r?\n/)

  let currentKey: 'setup' | 'archive' | null = null
  let currentValue = ''

  for (const line of lines) {
    // Another top-level key (not indented) — stop parsing scripts block
    if (/^\S/.test(line) && line.trim().length > 0) {
      break
    }

    // Indented key like "  setup: |" or "  archive: |" or "  setup: echo hello"
    const keyMatch = line.match(/^  (setup|archive):\s*(\|)?\s*(.*)$/)
    if (keyMatch) {
      // Save previous key
      if (currentKey) {
        hooks.scripts[currentKey] = currentValue.trimEnd()
      }
      currentKey = keyMatch[1] as 'setup' | 'archive'
      currentValue = keyMatch[3] ? `${keyMatch[3]}\n` : ''
      continue
    }

    // Content line (indented by 4+ spaces under a key)
    if (currentKey && line.startsWith('    ')) {
      currentValue += `${line.slice(4)}\n`
    }
  }

  // Save last key
  if (currentKey) {
    hooks.scripts[currentKey] = currentValue.trimEnd()
  }

  if (!hooks.scripts.setup && !hooks.scripts.archive) {
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

export function getEffectiveHooks(repo: Repo): OrcaHooks | null {
  const yamlHooks = loadHooks(repo.path)
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

export function getSetupCommandSource(repo: Repo): { source: 'yaml'; command: string } | null {
  const yamlSetup = loadHooks(repo.path)?.scripts.setup?.trim()

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
  const gitRelPath = useWindowsFormat ? 'orca/setup-runner.cmd' : 'orca/setup-runner.sh'
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
  repo: Repo
): Promise<{ success: boolean; output: string }> {
  const hooks = getEffectiveHooks(repo)
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
