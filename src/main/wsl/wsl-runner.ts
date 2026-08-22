import { addWslEnvKeys } from '../../shared/wsl-env'
import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
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

export type WslLane =
  /** No shell. Cached login PATH/HOME, applied via `env`. */
  | 'probe'
  /** Login shell, always fenced. For anything whose PATH must match the user's terminal. */
  | 'interactive'

/**
 * What to run: a single binary, or a script.
 *
 * Why a union rather than an optional `script`: a script has to arrive on
 * stdin, which means the program must be a shell reading stdin. Left to the
 * caller that is a footgun — and the wrappers this replaces exist because it
 * was never made explicit. `script` makes the runner supply `sh -s` itself.
 */
export type WslCommand =
  | { program: string; args?: readonly string[]; script?: never; shell?: never }
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
  /**
   * Required, with no default. The wrong lane is the most common WSL defect in
   * this tree, and a default lets a call site pick it by omission.
   */
  lane: WslLane
  /** Guest (POSIX) path. */
  cwd?: string
  /** Host variables to propagate into the guest; sets WSLENV automatically. */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
  /**
   * Proceed when the login PATH could not be established.
   *
   * Default is to throw. Three separate reviews found the same class of bug --
   * a call that answers "is this installed?" running on the bare default PATH
   * and reporting an nvm-installed tool absent (#9725). Making degradation
   * opt-in puts that decision in the one place a reader will look, instead of
   * relying on every call site to remember to check `environmentResolved`.
   */
  allowDegradedEnvironment?: boolean
}

export type WslResult = {
  /**
   * False when the login PATH could not be established, so the call ran on the
   * distro's default PATH. A caller deciding "is this tool installed?" must
   * report unverifiable rather than absent -- an nvm-installed binary is
   * invisible without the login PATH, which is #9725 exactly.
   */
  environmentResolved: boolean
  code: number | null
  /** Payload only — on the interactive lane the rc banner is removed by the fence. */
  stdout: string
  stderr: string
  timedOut: boolean
}

export const DEFAULT_WSL_TIMEOUT_MS = 30_000

/**
 * The guest login PATH could not be established.
 *
 * Typed so a caller answering "is this installed?" can report unverifiable
 * rather than absent -- reporting an nvm-installed tool absent is #9725, and a
 * bare Error would just be swallowed by the same catch that handles real
 * failures.
 */
export class WslGuestEnvironmentUnavailableError extends Error {
  constructor(distro: string | undefined) {
    super(`WSL guest environment for ${distro ?? 'the default distro'} is unavailable`)
    this.name = 'WslGuestEnvironmentUnavailableError'
  }
}

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

/** Host env plus the WSLENV entries that let it cross the boundary. */
function buildHostEnv(env: WslSpec['env']): NodeJS.ProcessEnv | undefined {
  if (!env || Object.keys(env).length === 0) {
    return undefined
  }
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env }
  addWslEnvKeys(merged, Object.keys(env))
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

/** `<shell> -s --` for a script on stdin, otherwise the program itself. */
function guestCommandArgv(spec: WslSpec): string[] {
  return spec.script !== undefined
    ? [spec.shell ?? 'sh', '-s', '--', ...(spec.args ?? [])]
    : [spec.program, ...(spec.args ?? [])]
}

/** Shell-free argv, with the cached environment applied when one is available. */
function buildGuestArgv(environment: WslGuestEnvironment | null, spec: WslSpec): string[] {
  const command = guestCommandArgv(spec)
  const argv = environment
    ? [environment.envBinary, `PATH=${environment.path}`, `HOME=${environment.home}`, ...command]
    : command
  return withGuestCwd(spec.cwd, argv)
}

function buildInteractiveArgv(spec: WslSpec): {
  argv: string[]
  readStdout: (stdout: string) => string
} {
  // Why the whole invocation goes through the fence: a caller that does not
  // parse stdout today may start tomorrow, and the banner is invisible until
  // then.
  const quoted = guestCommandArgv(spec).map(quotePosixShell).join(' ')
  const body = spec.cwd ? `cd ${quotePosixShell(spec.cwd)} || exit 1\n${quoted}` : quoted
  const captured = buildWslCapturedLoginShellCommand(body)
  return {
    argv: ['sh', '-c', captured.command],
    // Why throw rather than default to '': readStdout returns null precisely to
    // distinguish "the fence never appeared" from "the payload was empty". An rc
    // that redirects stdout, or output truncated before the begin marker, would
    // otherwise return a clean, empty, wrong answer.
    readStdout: (stdout: string) => {
      const payload = captured.readStdout(stdout)
      if (payload === null) {
        throw new Error('WSL login shell produced no fenced output')
      }
      return payload
    }
  }
}

/**
 * Run a program inside WSL.
 *
 * Throws when the guest login PATH cannot be established, unless the caller
 * passes `allowDegradedEnvironment`. Falling back to the login shell here would
 * re-run ~/.profile -- the stall this exists to remove.
 */
export async function runWslProcess(spec: WslSpec): Promise<WslResult> {
  if (spec.program !== undefined) {
    assertNotShellString(spec.program)
  }
  if (spec.cwd) {
    assertGuestPath(spec.cwd)
  }
  const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS)

  // Why both lanes when there is a script: a script never runs under the login
  // shell (see below), so on the interactive lane it would otherwise get no
  // login PATH at all -- strictly less than the probe lane, for a caller that
  // explicitly asked for the user's terminal PATH.
  const wantsEnvironment = spec.lane === 'probe' || spec.script !== undefined
  // Leave the command at least a third of the budget: a probe that eats it all
  // turns a healthy command into a spurious timeout.
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
  if (wantsEnvironment && environment === null && !spec.allowDegradedEnvironment) {
    throw new WslGuestEnvironmentUnavailableError(spec.distro)
  }

  const lane =
    spec.lane === 'interactive' && spec.script === undefined
      ? ({ kind: 'interactive', ...buildInteractiveArgv(spec) } as const)
      : ({ kind: 'probe', argv: buildGuestArgv(environment, spec) } as const)

  // One budget for the whole call: the probe used to run on its own 10s timer
  // ahead of the timed leg, so a 5s caller could wait 15s.
  const remainingMs = Math.max(1, deadline - Date.now())
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(spec.distro, lane.argv),
    env: buildHostEnv(spec.env),
    input: spec.script,
    timeoutMs: remainingMs,
    maxOutputBytes: spec.maxOutputBytes
  })

  return {
    environmentResolved: !wantsEnvironment || environment !== null,
    code: result.code,
    stdout: lane.kind === 'interactive' ? lane.readStdout(result.stdout) : result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}
