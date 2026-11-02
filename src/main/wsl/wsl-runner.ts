import { addWslEnvKeys } from '../../shared/wsl-env'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import { runProcess } from '@orca/process-host'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { getWslGuestEnvironment, type WslGuestEnvironment } from './wsl-guest-environment'
import { resolveWslExecutablePath } from './wsl-executable-path'

/** Shared WSL argv/environment/payload rules; see docs/reference/wsl-command-execution.md. */

/** Choose login PATH needs explicitly; separating this from failure handling avoids contradictory lane/opt-out flags. */
export type WslLoginPath =
  /** The command reads $HOME or absolute paths only. No probe. */
  | 'none'
  /** Use the cached login PATH when there is one; run anyway when there is not. */
  | 'preferred'

/** A script requires runner-selected shell handling; binary programs pass directly as argv. */
export type WslCommand =
  | {
      program: string
      args?: readonly string[]
      script?: never
      shell?: never
    }
  | {
      script: string
      args?: readonly string[]
      program?: never
      /** Defaults to sh (often dash); callers using [[ ]] or process substitution must explicitly request bash (#14292). */
      shell?: 'sh' | 'bash'
    }

export type WslSpec = WslCommand & {
  /** Undefined selects the distro's default. */
  distro?: string
  /** Guest user; undefined runs as the distro's default user. */
  user?: 'root'
  /** Callers must explicitly choose PATH policy to avoid hidden lookup assumptions. */
  loginPath: WslLoginPath
  /** Guest (POSIX) path. */
  cwd?: string
  /** Host variables to propagate into the guest; sets WSLENV automatically. */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
}

export type WslResult = {
  /** False means preferred PATH was unavailable: tool lookup is unverifiable, never absent (#9725). none always reports true and must only serve callers independent of login PATH. */
  environmentResolved: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when stdout or stderr hit `maxOutputBytes` and was clipped. */
  outputTruncated?: boolean
}

export const DEFAULT_WSL_TIMEOUT_MS = 30_000

function assertGuestPath(cwd: string): void {
  // Reject mistaken Windows cwd rather than silently mask the upstream error.
  if (!cwd.startsWith('/')) {
    throw new Error(`WSL cwd must be a guest path, received ${cwd}`)
  }
}

/** Use `script` to run a script; a command line here is the thing being prevented. */
function assertNotShellString(program: string): void {
  // --exec preserves spaced paths; reject shell metacharacters, not whitespace alone.
  if (/[;&|<>$`\n\r]/.test(program) || /^\S+\s+-/.test(program)) {
    throw new Error(`WSL program must be a single binary, received ${program}`)
  }
  // name=value after env is another assignment; no program means environment disclosure and exit 0.
  if (program.includes('=')) {
    throw new Error(`WSL program must not look like an assignment, received ${program}`)
  }
}

/** Always request UTF-8 for wsl.exe's own error messages; default UTF-16 would corrupt stderr even when guest output is ASCII (#9010). */
function buildHostEnv(env: WslSpec['env']): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env, WSL_UTF8: '1' }
  // Exclude path-shaped variables from WSLENV translation or Windows values replace the guest's own paths.
  const crossable = Object.keys(env ?? {}).filter(
    (key) => !['PATH', 'HOME', 'TMP', 'TEMP'].includes(key)
  )
  if (crossable.length > 0) {
    addWslEnvKeys(merged, crossable)
  }
  return merged
}

/** cd inside the guest; runProcess cwd is Windows-side and must never receive guest/UNC paths. */
function withGuestCwd(cwd: string | undefined, argv: readonly string[]): string[] {
  if (!cwd) {
    return [...argv]
  }
  assertGuestPath(cwd)
  // exec without operands succeeds doing nothing; reject empty commands.
  if (argv.length === 0) {
    throw new Error('WSL invocation has no command to run')
  }
  return ['sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'orca-wsl', cwd, ...argv]
}

/** `<shell> -c`/`-s` for a script, otherwise the program itself. */
function guestCommandArgv(spec: WslSpec, delivery: 'argv' | 'stdin'): string[] {
  if (spec.script === undefined) {
    return [spec.program, ...(spec.args ?? [])]
  }
  const shell = spec.shell ?? 'sh'
  // `--` keeps positional args starting at $1 under both forms.
  return delivery === 'stdin'
    ? [shell, '-s', '--', ...(spec.args ?? [])]
    : [shell, '-c', spec.script, '--', ...(spec.args ?? [])]
}

/** Shell-free argv, with the cached environment applied when one is available. */
function buildGuestArgv(
  environment: WslGuestEnvironment | null,
  spec: WslSpec,
  delivery: 'argv' | 'stdin'
): string[] {
  const command = guestCommandArgv(spec, delivery)
  const argv = environment
    ? [environment.envBinary, `PATH=${environment.path}`, `HOME=${environment.home}`, ...command]
    : command
  return withGuestCwd(spec.cwd, argv)
}

/** Missing preferred login PATH is nonfatal: use distro defaults and return environmentResolved=false. */
export async function runWslProcess(spec: WslSpec): Promise<WslResult> {
  if (spec.program !== undefined) {
    assertNotShellString(spec.program)
  }
  if (spec.cwd) {
    assertGuestPath(spec.cwd)
  }
  const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS)

  const wantsEnvironment = spec.loginPath === 'preferred'
  // Reserve at least half the remaining budget for the actual command; cap probing at 4s.
  const remainingForProbe = deadline - Date.now()
  const probeBudgetMs = Math.max(1, Math.min(4_000, Math.floor(remainingForProbe / 2)))
  const environment = wantsEnvironment
    ? await getWslGuestEnvironment(spec.distro, probeBudgetMs)
    : null

  // Never fall back to a blocking login shell after probe failure (#14288); use default PATH. Measure the complete argv including env before choosing transport.
  const argvForm = buildGuestArgv(environment, spec, 'argv')
  // Windows counts executable, distro and --exec prefix in the same command-line budget.
  const fullLine = [
    resolveWslExecutablePath(),
    ...buildWslExecArgs(spec.distro, argvForm, { user: spec.user })
  ]
  // Prefer argv to preserve stdin; oversized unbounded hooks must use stdin or fail to spawn.
  const delivery: 'argv' | 'stdin' =
    spec.script !== undefined && commandLineLength(fullLine) > MAX_COMMAND_LINE_CHARS
      ? 'stdin'
      : 'argv'
  const argv = delivery === 'argv' ? argvForm : buildGuestArgv(environment, spec, 'stdin')

  // Probe and command share one deadline; never add an independent probe timeout.
  const remainingMs = Math.max(1, deadline - Date.now())
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(spec.distro, argv, { user: spec.user }),
    // Use stable Windows cwd: inherited worktrees can disappear and break all later spawns (#16463). Guest cd stays inside.
    cwd: resolveWslInteropSpawnCwd(),
    env: buildHostEnv(spec.env),
    input: delivery === 'stdin' ? spec.script : undefined,
    timeoutMs: remainingMs,
    maxOutputBytes: spec.maxOutputBytes
  })

  return {
    environmentResolved: !wantsEnvironment || environment !== null,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated ?? false
  }
}
