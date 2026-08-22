import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { getHookRuntimeTarget, getHookWslContext } from './hook-runtime-target'
import { getSetupEnvVars } from './setup-hook-env-vars'
import { iterateLfScriptLines } from './setup-runner-script-text'
import { promptGuardShellEnv } from './git/runner'
import { toLinuxPath } from './wsl'
import { runWslProcess } from './wsl/wsl-runner'
import type { HookRuntimeTarget } from './hook-runtime-target'
import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'

const HOOK_TIMEOUT = 120_000 // 2 minutes

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
  'environmentRecipes',
  'worktree'
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

export function getEffectiveHooks(repo: Repo, worktreePath?: string): OrcaHooks | null {
  const hooksRoot = worktreePath ?? repo.path
  return getEffectiveHooksFromConfig(repo, loadHooks(hooksRoot))
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
    // Why: hook scripts run inside WSL, so translate the ORCA_* Windows UNC paths to Linux paths.
    const envVars = getSetupEnvVars(repo, cwd)
    const wslEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(envVars)) {
      wslEnv[key] = toLinuxPath(value)
    }
    // Why: same unattended-git guard as the non-WSL branch below (issue
    // #7652) — only the guard flags and any indexed git-config protocol are
    // meant to reach the guest; askpass stays host-side, same as before.
    const guardedEnv = promptGuardShellEnv(wslEnv)
    const guestEnv: Record<string, string> = { ...wslEnv }
    for (const [key, value] of Object.entries(guardedEnv)) {
      if (
        value !== undefined &&
        (key === 'GIT_TERMINAL_PROMPT' || key === 'GCM_INTERACTIVE' || key.startsWith('GIT_CONFIG_'))
      ) {
        guestEnv[key] = value
      }
    }

    return runWslProcess({
      distro: wslInfo.distro ?? undefined,
      lane: 'probe',
      script,
      // Why pinned: these are user-authored orca.yaml scripts and the native
      // path runs /bin/bash. Defaulting to sh would fail bash-only hooks on WSL
      // only -- a downgrade the user never asked for.
      shell: 'bash',
      // Why degrade rather than fail: a hook is an action, not an "is this
      // installed?" question. Before the runner it ran on the default PATH when
      // no login shell was available; refusing would turn worktree setup into a
      // hard failure whenever WSL is briefly slow.
      allowDegradedEnvironment: true,
      cwd: wslInfo.linuxPath,
      env: guestEnv,
      timeoutMs: HOOK_TIMEOUT
    })
      .then((result) => {
        if (result.timedOut) {
          const message = `Hook timed out after ${HOOK_TIMEOUT}ms.`
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, message)
          return { success: false, output: `${result.stdout}\n${result.stderr}\n${message}`.trim() }
        }
        if (result.code !== 0) {
          const message = `Command failed with exit code ${result.code}.`
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, message)
          return { success: false, output: `${result.stdout}\n${result.stderr}\n${message}`.trim() }
        }
        console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
        return { success: true, output: `${result.stdout}\n${result.stderr}`.trim() }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, message)
        return { success: false, output: message }
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
