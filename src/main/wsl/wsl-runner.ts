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
 * Five decisions have to be made on every `wsl.exe` call, each has a right
 * answer, and each has shipped wrong:
 *
 * - **Separator.** `--` makes wsl.exe expand `$name` in every forwarded
 *   argument before the guest runs, even with no shell in the command, so
 *   `awk '{print $2}'` loses its field reference (#12964). Always `--exec`.
 * - **Shell.** A login shell on a probe path sources `~/.profile`, so one
 *   blocking line eats the whole timeout (#14288) and every call pays startup
 *   (#9768). No login shell on a user-facing path means PATH does not match the
 *   user's terminal, so nvm-installed agents read as absent (#9725, #7563,
 *   #8366). Hence two lanes, chosen explicitly.
 * - **Fencing.** An interactive login shell runs the distro rc, and stock
 *   Ubuntu writes its "run as administrator" hint to *stdout*, so anything
 *   parsing that stream reads the banner as data (#11327, #11823).
 * - **WSLENV.** Unset, a Windows-side variable silently never crosses into the
 *   guest (#12557).
 * - **Payload.** Scripts go in on stdin. A script on stdin has no quoting
 *   boundary to escape from, which is what the base64 and `eval` wrappers were
 *   working around (#14292).
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
  | { program: string; args?: readonly string[]; script?: never }
  | { script: string; args?: readonly string[]; program?: never }

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
  signal?: AbortSignal
}

export type WslResult = {
  code: number | null
  /** Payload only — on the interactive lane the rc banner is removed by the fence. */
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

function assertNotShellString(program: string): void {
  // Why: the base64 and eval wrappers exist because this boundary was never
  // enforced. `script` is the supported way to run a script.
  //
  // Why metacharacters and not whitespace: a guest binary may legitimately live
  // under a path containing a space, and --exec passes it as one argv element,
  // so a space is harmless. A `;` or `|` means the caller is building a command
  // line, which is the thing being prevented.
  if (/[;&|<>$`\n\r]/.test(program) || /^\S+\s+-/.test(program)) {
    throw new Error(`WSL program must be a single binary, received ${program}`)
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
  return ['sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'orca-wsl', cwd, ...argv]
}

/** `sh -s --` for a script on stdin, otherwise the program itself. */
function guestCommandArgv(spec: WslSpec): string[] {
  return spec.script !== undefined
    ? ['sh', '-s', '--', ...(spec.args ?? [])]
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
    readStdout: (stdout: string) => captured.readStdout(stdout) ?? ''
  }
}

/**
 * Run a program inside WSL.
 *
 * Falls back from the probe lane to the interactive lane when the distro's
 * environment cannot be probed — an unprobed distro is "we could not ask", and
 * running with no PATH at all would turn that into a wrong answer.
 */
export async function runWslProcess(spec: WslSpec): Promise<WslResult> {
  if (spec.program !== undefined) {
    assertNotShellString(spec.program)
  }
  if (spec.cwd) {
    assertGuestPath(spec.cwd)
  }

  const environment = spec.lane === 'probe' ? await getWslGuestEnvironment(spec.distro) : null
  // Why a script never takes the interactive lane: the login shell owns stdin,
  // and the script is delivered on stdin. If the shell consumes it first, the
  // inner `sh -s` reads EOF, runs nothing, and exits 0 -- a silent wrong answer,
  // which is strictly worse than the degraded PATH avoided by taking this path.
  // A script therefore always runs as `--exec sh -s --`, with the cached
  // environment applied when there is one.
  const lane =
    environment === null && spec.script === undefined
      ? // Why fall back rather than run with no PATH: an unprobed distro is
        // "we could not ask", and answering with an empty environment turns
        // that into a wrong answer.
        ({ kind: 'interactive', ...buildInteractiveArgv(spec) } as const)
      : ({ kind: 'probe', argv: buildGuestArgv(environment, spec) } as const)

  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(spec.distro, lane.argv),
    env: buildHostEnv(spec.env),
    input: spec.script,
    timeoutMs: spec.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS,
    maxOutputBytes: spec.maxOutputBytes,
    signal: spec.signal
  })

  return {
    code: result.code,
    stdout: lane.kind === 'interactive' ? lane.readStdout(result.stdout) : result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}
