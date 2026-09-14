import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { getHookRuntimeTarget, getHookWslContext } from './hook-runtime-target'
import { getSetupEnvVars } from './setup-hook-env-vars'
import { iterateLfScriptLines } from './setup-runner-script-text'
import { promptGuardShellEnv } from './git/runner'
import { dropIncoherentCondaActivationEnv } from './pty/conda-activation-env'
import { toLinuxPath } from './wsl'
import { runWslProcess } from './wsl/wsl-runner'
import type { HookRuntimeTarget } from './hook-runtime-target'
import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import { exec } from 'node:child_process'

const HOOK_TIMEOUT = 120_000 // 2 minutes

type HookProcessOutcome = { success: boolean; output: string; exitCode?: number }

/**
 * Turn a finished process into a hook verdict.
 *
 * Why `timedOut` decides before `code` (#19334): a hook that traps SIGTERM and exits 0 reports a
 * zero exit for a run we cut off mid-archive. The exit code of something we stopped is not
 * evidence it finished, so a timeout withholds the code and the removal gate reads that as
 * `unverifiable` rather than as a pass.
 */
function classifyHookProcessResult(
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  context: { hookName: string; cwd: string; timeoutMs: number }
): HookProcessOutcome {
  const streams = `${result.stdout}\n${result.stderr}`
  if (result.timedOut) {
    const message = `Hook timed out after ${context.timeoutMs}ms.`
    console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, message)
    return { success: false, output: `${streams}\n${message}`.trim() }
  }
  if (result.code !== 0) {
    const message = `Command failed with exit code ${result.code}.`
    console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, message)
    return {
      success: false,
      output: `${streams}\n${message}`.trim(),
      ...(typeof result.code === 'number' ? { exitCode: result.code } : {})
    }
  }
  console.log(`[hooks] ${context.hookName} hook completed in ${context.cwd}`)
  return { success: true, output: streams.trim() }
}

const SIGTERM_GRACE_MS = 2_000

/** Signal the hook's whole process group where the platform has one, else just the child. */
export type TerminableChild = {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: (signal: NodeJS.Signals) => boolean
}

export function terminateHookTree(child: TerminableChild, signal: NodeJS.Signals): void {
  // Why probe the GROUP and not the child: the escalation exists for descendants that outlive the
  // shell. A hook that backgrounds a server typically loses its leader to the first SIGTERM while
  // the server keeps running, so keying this on `child.exitCode` would skip the SIGKILL in exactly
  // the case it was added for.
  //
  // The trade-off it does not solve: signalling by negative pid names whatever group owns that pid
  // now. Once the leader is reaped its pid can be recycled, and a probe cannot tell a surviving
  // descendant from a stranger that inherited the number. Killing a runaway hook is the likelier
  // event and the one the deadline promises, so the group is signalled whenever it answers; the
  // residual window is pid wraparound inside the two-second grace.
  if (process.platform !== 'win32' && child.pid) {
    try {
      // Signal 0 tests for members without delivering anything: ESRCH means the group is empty.
      process.kill(-child.pid, 0)
    } catch {
      return
    }
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Raced with the last member exiting; fall through to the direct kill.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  try {
    child.kill(signal)
  } catch {
    // Already dead.
  }
}

/** An `exec` failure: a string `code` (ENOENT) means it never started, so no exit was observed. */
function hookProcessError(
  error: Error,
  stdout: string,
  stderr: string,
  context: { hookName: string; cwd: string }
): HookProcessOutcome {
  const code = 'code' in error ? error.code : undefined
  console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, error.message)
  return {
    success: false,
    output: `${stdout}\n${stderr}\n${error.message}`.trim(),
    ...(typeof code === 'number' ? { exitCode: code } : {})
  }
}

/** A hook that never started reported no exit, so the code stays withheld. */
function hookSpawnFailure(
  error: unknown,
  context: { hookName: string; cwd: string }
): HookProcessOutcome {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[hooks] ${context.hookName} hook failed in ${context.cwd}:`, message)
  return { success: false, output: message }
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
  'setupAgentStartupPolicy',
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
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  /** Deadline override. Production uses HOOK_TIMEOUT; tests use it to exercise the timeout path. */
  timeoutMs: number = HOOK_TIMEOUT
  // Why (#19334): an absent exitCode means no exit was ever observed. The archive-hook removal
  // gate reads that as `unverifiable` rather than folding it into a zero.
): Promise<{ success: boolean; output: string; exitCode?: number }> {
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
        (key === 'GIT_TERMINAL_PROMPT' ||
          key === 'GCM_INTERACTIVE' ||
          key.startsWith('GIT_CONFIG_'))
      ) {
        guestEnv[key] = value
      }
    }

    return runWslProcess({
      distro: wslInfo.distro ?? undefined,
      loginPath: 'preferred',
      script,
      // Why pinned: these are user-authored orca.yaml scripts and the native
      // path runs /bin/bash. Defaulting to sh would fail bash-only hooks on WSL
      // only -- a downgrade the user never asked for.
      shell: 'bash',
      cwd: wslInfo.linuxPath,
      env: guestEnv,
      timeoutMs
    })
      .then((result) => classifyHookProcessResult(result, { hookName, cwd, timeoutMs }))
      .catch((error: unknown) => hookSpawnFailure(error, { hookName, cwd }))
  }

  const shellHookEnv: NodeJS.ProcessEnv = { ...process.env, ...getSetupEnvVars(repo, cwd) }
  dropIncoherentCondaActivationEnv(shellHookEnv)

  return new Promise<HookProcessOutcome>((resolve) => {
    // Why we own the deadline (#19334): Node's `exec({ timeout })` SIGTERMs the child and then
    // reports whatever it chose to do, so a hook that traps SIGTERM and exits 0 came back as a
    // PASS — a hook cut off mid-archive, indistinguishable from one that finished. Settle on the
    // deadline instead, and settle AT it, so a hook that traps and keeps running cannot hold a
    // removal open. `exec` stays because it owns the per-platform shell invocation (`cmd.exe`
    // wants `/d /s /c`, not `-c`), which is not this change's to re-derive.
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    const settle = (result: HookProcessOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      resolve(result)
    }
    const child = exec(
      script,
      {
        cwd,
        shell: getHookShell(),
        // Why: hooks run unattended; block Git Credential Manager's interactive prompt while keeping cached auth (issue #7652).
        env: promptGuardShellEnv(shellHookEnv),
        // Signal the whole group on POSIX: the script is a shell, and the work is its children.
        ...(process.platform === 'win32' ? {} : { detached: true })
      },
      (error, stdout, stderr) => {
        if (error) {
          settle(hookProcessError(error, stdout, stderr, { hookName, cwd }))
          return
        }
        settle(
          classifyHookProcessResult(
            { code: 0, stdout, stderr, timedOut: false },
            { hookName, cwd, timeoutMs }
          )
        )
      }
    )
    // Why guarded: `exec`'s callback can fire synchronously (the unit test's mock does), and arming
    // a deadline on an already-settled run would later signal a process group whose pid is long
    // gone — and may by then belong to something else.
    if (!settled) {
      deadline = setTimeout(() => {
        settle(
          classifyHookProcessResult(
            { code: null, stdout: '', stderr: '', timedOut: true },
            { hookName, cwd, timeoutMs }
          )
        )
        terminateHookTree(child, 'SIGTERM')
        setTimeout(() => terminateHookTree(child, 'SIGKILL'), SIGTERM_GRACE_MS).unref?.()
      }, timeoutMs)
    }
  })
}
