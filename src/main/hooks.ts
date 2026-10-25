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
import { spawn } from 'node:child_process'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'

const HOOK_TIMEOUT = 120_000

type HookProcessOutcome = { success: boolean; output: string; exitCode?: number }

/** Timed-out hooks cannot prove completion, even if their SIGTERM handler exits 0 (#19334). */
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
    // A signaled exit has no code for the removal gate to verify.
    const message =
      result.code === null
        ? 'Command was terminated without reporting an exit code.'
        : `Command failed with exit code ${result.code}.`
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

/** Bound retained output without failing chatty hooks that otherwise succeed. */
const HOOK_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024

function readSink(sink: ReturnType<typeof createOutputSink>): string {
  return sink.truncated()
    ? `${sink.text()}\n[output truncated at ${HOOK_OUTPUT_LIMIT_BYTES} bytes]`
    : sink.text()
}

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

export function hasHooksFile(repoPath: string): boolean {
  return existsSync(join(repoPath, 'orca.yaml'))
}

// Unknown keys suggest a newer config format; let the UI offer an update.
const RECOGNIZED_ORCA_YAML_KEYS = new Set([
  'scripts',
  'setupAgentStartupPolicy',
  'issueCommand',
  'defaultTabs',
  'environmentRecipes',
  'worktree'
])

export function hasUnrecognizedOrcaYamlKeys(repoPath: string): boolean {
  try {
    const content = readFileSync(join(repoPath, 'orca.yaml'), 'utf-8')
    for (const line of iterateLfScriptLines(content)) {
      // A bare key: is valid YAML when its block value follows on the next line.
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

export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo,
  hooksPath?: string,
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget,
  timeoutMs: number = HOOK_TIMEOUT
  // Failed hooks without an observed exit are unverifiable to the removal gate (#19334).
): Promise<{ success: boolean; output: string; exitCode?: number }> {
  const hooks = getEffectiveHooks(repo, hooksPath)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  const runtimeTarget = getHookRuntimeTarget(projectRuntime)
  const wslInfo = getHookWslContext(cwd, runtimeTarget)

  if (wslInfo) {
    // WSL hooks need Linux paths for ORCA_* values, including Windows UNC paths.
    const envVars = getSetupEnvVars(repo, cwd)
    const wslEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(envVars)) {
      wslEnv[key] = toLinuxPath(value)
    }
    // Forward unattended Git flags and indexed config to WSL; keep host askpass out of the guest.
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
      // Match native Bash hook semantics; sh would reject Bash-only scripts inside WSL.
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
    // Settle at the deadline even if the hook traps SIGTERM or keeps running (#19334).
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
    // exec ignores detached; spawn creates the process group needed for tree termination.
    const child = spawn(script, {
      cwd,
      shell: getHookShell(),
      // Unattended hooks must suppress interactive Git prompts while retaining cached auth (#7652).
      env: promptGuardShellEnv(shellHookEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Hide Windows hook consoles to prevent flashes and focus theft.
      windowsHide: true,
      // POSIX groups let signals reach descendants; Windows detached would create a new console.
      ...(process.platform === 'win32' ? {} : { detached: true })
    })
    const stdout = createOutputSink(HOOK_OUTPUT_LIMIT_BYTES)
    const stderr = createOutputSink(HOOK_OUTPUT_LIMIT_BYTES)
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk))
    // Unhandled stream errors crash main; retain exit reporting even when output fails.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }
    child.on('error', (error) => {
      settle(hookProcessError(error, readSink(stdout), readSink(stderr), { hookName, cwd }))
    })
    child.on('close', (code, signal) => {
      settle(
        classifyHookProcessResult(
          {
            code: signal ? null : code,
            stdout: readSink(stdout),
            stderr: readSink(stderr),
            timedOut: false
          },
          { hookName, cwd, timeoutMs }
        )
      )
    })
    // Arming after settlement could later signal a reused PID.
    if (!settled) {
      deadline = setTimeout(() => {
        settle(
          classifyHookProcessResult(
            { code: null, stdout: readSink(stdout), stderr: readSink(stderr), timedOut: true },
            { hookName, cwd, timeoutMs }
          )
        )
        // Terminate descendants too, with a SIGTERM grace period for cooperative hooks to clean up.
        void signalProcessTree(child, 'SIGTERM')
        setTimeout(() => {
          void forceTerminateProcessTree(child)
        }, SIGTERM_GRACE_MS).unref?.()
      }, timeoutMs)
    }
  })
}
