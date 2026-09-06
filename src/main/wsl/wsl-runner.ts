import { addWslEnvKeys } from '../../shared/wsl-env'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { getWslGuestEnvironment, type WslGuestEnvironment } from './wsl-guest-environment'
import { resolveWslExecutablePath } from './wsl-executable-path'

/**
 * The single place Orca runs a program inside WSL.
 *
 * Five things have to be decided per call -- separator, shell, stdout fencing,
 * WSLENV, payload transport -- and each has shipped wrong: #12964, #14288 /
 * #9768 / #9725, #11327, #12557, #14292 respectively. See
 * docs/reference/wsl-command-execution.md.
 */

/**
 * How much the call needs the user's login PATH.
 *
 * Why one axis and not `lane` + `allowDegradedEnvironment`: 19 of 23 sites
 * passed the opt-out, and two of them said in comments that they did not want
 * the login PATH at all -- the flag had become the `'none'` this union was
 * missing. A required discriminator whose default nobody wants is not a
 * discriminator.
 */
export type WslLoginPath =
  /** The command reads $HOME or absolute paths only. No probe. */
  | 'none'
  /** Use the cached login PATH when there is one; run anyway when there is not. */
  | 'preferred'

/**
 * What to run: a single binary, or a script.
 *
 * Why a union rather than an optional `script`: a script needs a shell to run
 * it, and picking one per call site is how the wrappers this replaces drifted
 * apart. `script` makes the runner supply the shell, and `shell` says which.
 */
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
      /**
       * Interpreter for `script`. Defaults to `sh`, which on Debian and Ubuntu
       * is dash.
       *
       * Why this is not just always `sh`: a payload using process substitution
       * (`done < <(find ...)`), `local`, or `[[ ]]` is bash-only, and dash
       * rejects it with `Syntax error: word unexpected` -- the exact signature
       * in #14292. A caller that writes bash must say so; silently downgrading
       * its interpreter is how that error reaches users.
       */
      shell?: 'sh' | 'bash'
    }

export type WslSpec = WslCommand & {
  /** Undefined selects the distro's default. */
  distro?: string
  /** Required, with no default: the wrong answer here is the defect this file exists to prevent. */
  loginPath: WslLoginPath
  /** Guest (POSIX) path. */
  cwd?: string
  /** Host variables to propagate into the guest; sets WSLENV automatically. */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
}

export type WslResult = {
  /**
   * False when `loginPath: 'preferred'` could not establish the login PATH, so
   * the call ran on the distro's default PATH. A caller deciding "is this tool
   * installed?" must then report unverifiable rather than absent -- an
   * nvm-installed binary is invisible without it, which is #9725 exactly.
   *
   * Always true under `loginPath: 'none'`, because such a command asked for no
   * PATH and cannot be let down by one. A PATH lookup marked 'none' therefore
   * gets no protection from this field; the value has to be right.
   */
  environmentResolved: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export const DEFAULT_WSL_TIMEOUT_MS = 30_000

function assertGuestPath(cwd: string): void {
  // Why reject rather than convert: a caller passing a Windows path here has
  // usually made a different mistake further up, and silently translating it
  // hides that.
  if (!cwd.startsWith('/')) {
    throw new Error(`WSL cwd must be a guest path, received ${cwd}`)
  }
}

/** Use `script` to run a script; a command line here is the thing being prevented. */
function assertNotShellString(program: string): void {
  // Metacharacters, not whitespace: --exec passes argv elements, so a spaced
  // path is fine.
  if (/[;&|<>$`\n\r]/.test(program) || /^\S+\s+-/.test(program)) {
    throw new Error(`WSL program must be a single binary, received ${program}`)
  }
  // After `env PATH=… HOME=…`, a name=value program is a third assignment: env
  // prints the environment and exits 0.
  if (program.includes('=')) {
    throw new Error(`WSL program must not look like an assignment, received ${program}`)
  }
}

/**
 * Host env plus WSL_UTF8 and the WSLENV entries that let values cross.
 *
 * Why WSL_UTF8 unconditionally: without it `wsl.exe` writes its OWN messages
 * ("There is no distribution with the supplied name") as UTF-16LE, so every
 * caller that surfaces stderr shows NUL-riddled text. Setting it per-call site
 * is how it got lost -- the relay set it, the migration dropped it, and nothing
 * noticed because the happy path is pure ASCII. Credit: #9010.
 */
function buildHostEnv(env: WslSpec['env']): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env, WSL_UTF8: '1' }
  // Never name a path-shaped variable in WSLENV. wsl.exe translates those
  // between Windows and Linux form, so forwarding PATH replaces the guest's
  // own PATH with a translated Windows one -- silently, and this runner exists
  // to make that class of mistake impossible rather than to document it.
  const crossable = Object.keys(env ?? {}).filter(
    (key) => !['PATH', 'HOME', 'TMP', 'TEMP'].includes(key)
  )
  if (crossable.length > 0) {
    addWslEnvKeys(merged, crossable)
  }
  return merged
}

/**
 * `cd` into the guest cwd before the program.
 *
 * Why not `runProcess`'s `cwd`: that is a *Windows* directory for `wsl.exe`,
 * not a guest one. Passing a guest path there fails, and passing the UNC form
 * makes wsl.exe start in a network location.
 */
function withGuestCwd(cwd: string | undefined, argv: readonly string[]): string[] {
  if (!cwd) {
    return [...argv]
  }
  assertGuestPath(cwd)
  // Why: `exec` with no operands is a no-op, so the wrapper would cd and exit 0
  // having run nothing -- the one shape that turns it into a silent success.
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

/**
 * Run a program inside WSL.
 *
 * A missing login PATH is never fatal: the call runs on the distro's default
 * PATH and reports `environmentResolved: false`. Every knob this file used to
 * carry -- cooldown tiers, budget splitting, a re-probe heuristic, an opt-out
 * flag on 19 of 23 sites -- existed only because that case used to throw.
 */
export async function runWslProcess(spec: WslSpec): Promise<WslResult> {
  if (spec.program !== undefined) {
    assertNotShellString(spec.program)
  }
  if (spec.cwd) {
    assertGuestPath(spec.cwd)
  }
  const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS)

  const wantsEnvironment = spec.loginPath === 'preferred'
  // Cap the probe at half the budget and at 4s: a 5s caller was giving the
  // probe 3333ms and its own command 1667ms, tighter than the 5s it had before
  // the runner existed, which is how a cold distro read as "not installed".
  const remainingForProbe = deadline - Date.now()
  const probeBudgetMs = Math.max(1, Math.min(4_000, Math.floor(remainingForProbe / 2)))
  const environment = wantsEnvironment
    ? await getWslGuestEnvironment(spec.distro, probeBudgetMs)
    : null

  // Probe failure must NOT fall back to the login shell. That lane sources
  // ~/.profile, which is the stall this runner exists to remove (#14288) -- and
  // the probe most often fails *because* the distro is slow, so the fallback
  // would hit the hazard exactly when it is worst. Run shell-free with the
  // distro's default PATH instead: degraded, never blocking.
  // Build the argv form first and measure it: the env prefix is part of the
  // budget, so only the finished line can say whether argv fits. Resolved once
  // here because the argv shape and the stdin payload must agree.
  const argvForm = buildGuestArgv(environment, spec, 'argv')
  // Measure what is actually spawned: `wsl.exe` and `-d <distro> --exec` are
  // prepended after this point and are part of the same budget.
  const fullLine = [resolveWslExecutablePath(), ...buildWslExecArgs(spec.distro, argvForm)]
  // Argv is the default, but it has a hard ceiling that stdin does not. A user's
  // `orca.yaml` hook is the one unbounded script Orca runs, so past the cap the
  // choice is between failing to spawn at all and accepting the stdin caveat.
  const delivery: 'argv' | 'stdin' =
    spec.script !== undefined && commandLineLength(fullLine) > MAX_COMMAND_LINE_CHARS
      ? 'stdin'
      : 'argv'
  const argv = delivery === 'argv' ? argvForm : buildGuestArgv(environment, spec, 'stdin')

  // One budget for the whole call: the probe used to run on its own 10s timer
  // ahead of the timed leg, so a 5s caller could wait 15s.
  const remainingMs = Math.max(1, deadline - Date.now())
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(spec.distro, argv),
    // Name a Windows directory rather than inheriting one: an inherited cwd that
    // is later deleted (the worktree Orca launched from) fails every later spawn
    // (#16463). Never the guest cwd -- withGuestCwd still cds inside.
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
    timedOut: result.timedOut
  }
}
