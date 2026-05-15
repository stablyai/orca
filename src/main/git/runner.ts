/* eslint-disable max-lines -- Why: command routing, WSL translation, and
git/gh/glab wrappers must stay co-located so platform behavior remains
consistent across every repo-scoped subprocess call. */
/**
 * Centralized git/gh/command runner with transparent WSL support.
 *
 * Why: When a repo lives on a WSL filesystem (UNC path like \\wsl.localhost\Ubuntu\...),
 * native Windows binaries (git.exe, gh.exe, rg.exe) are either absent or extremely slow.
 * This module detects WSL paths and routes command execution through `wsl.exe -d <distro>`
 * with translated Linux paths, so every call site gets WSL support for free.
 */
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { parseWslPath, toWindowsWslPath, type WslPathInfo } from '../wsl'

const execFileAsync = promisify(execFile)

// ─── Core resolution ────────────────────────────────────────────────

type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  /** Non-null when the command was routed through WSL. */
  wsl: WslPathInfo | null
}

/**
 * Translate any Windows-style paths in command arguments to Linux paths
 * when the command will execute inside WSL.
 *
 * Why: callers like worktree-create pass Windows paths (e.g. the workspace
 * directory) as git arguments. WSL git doesn't understand Windows paths,
 * so we must translate them. WSL UNC paths (\\wsl.localhost\...) are
 * converted to their native Linux form; regular Windows drive paths
 * (C:\Users\...) are converted to /mnt/c/Users/...
 */
function translateArgsForWsl(args: string[]): string[] {
  return args.map((arg) => {
    // WSL UNC path → native linux path
    const wslInfo = parseWslPath(arg)
    if (wslInfo) {
      return wslInfo.linuxPath
    }

    // Windows drive path (e.g. C:\Users\...) → /mnt/c/Users/...
    const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
    if (driveMatch) {
      const driveLetter = driveMatch[1].toLowerCase()
      const rest = driveMatch[2].replace(/\\/g, '/')
      return `/mnt/${driveLetter}/${rest}`
    }

    return arg
  })
}

function hasExplicitRepoArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (
      (args[i] === '--repo' || args[i] === '-R') &&
      typeof args[i + 1] === 'string' &&
      args[i + 1].trim()
    ) {
      return true
    }
    if (args[i].startsWith('--repo=') || args[i].startsWith('-R=')) {
      return args[i].slice(args[i].indexOf('=') + 1).trim().length > 0
    }
    if (args[i].startsWith('-R') && args[i].length > 2) {
      return args[i].slice(2).trim().length > 0
    }
  }
  return false
}

function argsUseGhApiPlaceholders(args: string[]): boolean {
  return args.some(
    (arg) => arg.includes('{owner}') || arg.includes('{repo}') || arg.includes('{branch}')
  )
}

function canRunGitHubCliWithoutRepoCwd(args: string[]): boolean {
  if (hasExplicitRepoArg(args)) {
    return true
  }
  if (args[0] === 'api') {
    return !argsUseGhApiPlaceholders(args)
  }
  return args[0] === 'auth'
}

function isMissingCommandInWsl(stderr: string, command: string): boolean {
  const s = stderr.toLowerCase()
  const c = command.toLowerCase()
  return s.includes(`${c}: command not found`) || s.includes(`${c}: not found`)
}

function canFallBackToHostGitHubCli(
  command: 'gh',
  args: string[],
  resolved: ResolvedCommand,
  stderr: string
): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl !== null &&
    isMissingCommandInWsl(stderr, command) &&
    canRunGitHubCliWithoutRepoCwd(args)
  )
}

function resolveHostGitHubCli(command: 'gh', args: string[]): ResolvedCommand {
  return {
    binary: command,
    args,
    // Why: host gh cannot use a WSL UNC cwd reliably. We only fall back
    // for commands with explicit repo/API context, so no repo cwd is required.
    cwd: undefined,
    wsl: null
  }
}

/**
 * Given a command, its arguments, and a working directory, resolve whether
 * the invocation should be routed through wsl.exe.
 *
 * Why `bash -c "cd ... && ..."` instead of `--cd`: wsl.exe's --cd flag
 * does not work reliably when invoked via Node's execFile/spawn (it fails
 * with ERROR_PATH_NOT_FOUND in some configurations). Using bash -c with
 * an explicit cd is universally supported.
 */
function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  wslDistroOverride?: string
): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null }
  }

  // Why: global gh callers (rate_limit, listAccessibleProjects) have no
  // meaningful cwd to derive a WSL distro from. On WSL-only Windows setups,
  // gh.exe isn't on the host PATH and the spawn fails with ENOENT. Allow
  // callers to pass a distro hint so we can route through wsl.exe regardless.
  // TODO(wsl-default-distro): the codebase currently has no persistent
  // "default WSL distro" setting — distros are derived from individual repo
  // paths. Until such a setting exists, global gh callers without an explicit
  // override silently fall back to host gh.exe, which on WSL-only Windows
  // installs will ENOENT. The wslDistroOverride parameter is the hook for
  // wiring a future setting in without re-plumbing the runner.
  const cwdWsl = cwd ? parseWslPath(cwd) : null
  const wsl: WslPathInfo | null =
    cwdWsl ?? (wslDistroOverride ? { distro: wslDistroOverride, linuxPath: '' } : null)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // Why: shell-escape each argument to prevent word splitting / glob expansion
  // inside the bash -c string. Single quotes are safe for all chars except
  // single quotes themselves, which we escape as '\'' (end quote, escaped
  // literal, reopen quote).
  const escapedArgs = translatedArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`)
  // Why: when cwd is supplied as a WSL UNC path, prepend `cd <linuxPath> &&`
  // so the command runs in the expected directory. When the caller only
  // supplied a distro override (no cwd), skip the cd entirely — the gh CLI
  // doesn't need a particular cwd for global calls like `api rate_limit`.
  const shellCmd = cwdWsl
    ? `cd '${cwdWsl.linuxPath.replace(/'/g, "'\\''")}' && ${command} ${escapedArgs.join(' ')}`
    : `${command} ${escapedArgs.join(' ')}`

  return {
    binary: 'wsl.exe',
    args: ['-d', wsl.distro, '--', 'bash', '-c', shellCmd],
    // Why: cwd is set to undefined because wsl.exe handles directory switching
    // via the cd inside bash -c. Setting a UNC cwd on the Node process would
    // be redundant and can cause issues with some Node internals.
    cwd: undefined,
    wsl
  }
}

// ─── Git-specific runners ───────────────────────────────────────────

type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
export async function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCommand('git', args, options.cwd)
  const { stdout, stderr } = await execFileAsync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    env: options.env
  })
  return { stdout: stdout as string, stderr: stderr as string }
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export async function gitExecFileAsyncBuffer(
  args: string[],
  options: { cwd: string; maxBuffer?: number }
): Promise<{ stdout: Buffer }> {
  const resolved = resolveCommand('git', args, options.cwd)
  const { stdout } = (await execFileAsync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer
  })) as { stdout: Buffer }
  return { stdout }
}

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  return execFileSync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: options.encoding ?? 'utf-8',
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe']
  }) as string
}

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export function gitSpawn(args: string[], options: SpawnOptions & { cwd: string }): ChildProcess {
  const resolved = resolveCommand('git', args, options.cwd)
  return spawn(resolved.binary, resolved.args, {
    ...options,
    cwd: resolved.cwd
  })
}

// ─── gh CLI runners ─────────────────────────────────────────────────

// Why: non-repo-scoped gh calls (listAccessibleProjects, rate_limit, etc.)
// have no meaningful cwd. Allow it to be omitted so the one WSL-aware wrapper
// serves both repo-scoped and global callers and we stop having two spawn
// sites (the other one — a plain execFileAsync in project-view.ts — bypasses
// retry/backoff and any future quota tracker).
// Why: `wslDistro` is an explicit hint for global (cwd-less) gh callers on
// WSL-only Windows installs where gh.exe isn't on the host PATH. When set,
// resolveCommand routes the spawn through `wsl.exe -d <distro> -- gh ...`
// even without a UNC cwd to parse a distro from. Repo-scoped callers should
// keep using cwd — the distro derives from the path automatically there.
// Why: `idempotent` gates the transient-error retry. When undefined we
// auto-detect from argv (writes are detected by `-X POST/PATCH/PUT/DELETE`
// or a `query=mutation …` arg); callers can also pass an explicit override.
// A 5xx/socket reset after the request reaches GitHub but before the
// response returns is the canonical case where the server-side write
// succeeded; retrying would create a duplicate comment/issue/label addition.
// See bug-scan finding 1.
type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
}

const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
// `gh <noun> <verb>` write subcommands. Reads (view/list/status/checks)
// are absent on purpose so the default of "retry" stays for them.
const NON_IDEMPOTENT_GH_VERBS = new Set([
  'create',
  'edit',
  'update',
  'delete',
  'close',
  'reopen',
  'merge',
  'comment',
  'review',
  'ready',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'transfer',
  'develop'
])

function argsLookIdempotent(args: string[]): boolean {
  let explicitMethodSeen = false
  let hasApiBodyField = false
  let hasGraphQlQuery = false
  const isGraphQlApi = args[0] === 'api' && args[1] === 'graphql'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--method') {
      explicitMethodSeen = true
      const next = args[i + 1]
      if (typeof next === 'string' && NON_IDEMPOTENT_METHODS.has(next.toUpperCase())) {
        return false
      }
    }
    // Single-token form `--method=POST` (gh accepts this).
    if (a.startsWith('--method=')) {
      explicitMethodSeen = true
      const value = a.slice('--method='.length)
      if (NON_IDEMPOTENT_METHODS.has(value.toUpperCase())) {
        return false
      }
    }
    // `gh api` auto-switches GET→POST when -f/-F/--field/--raw-field body
    // fields are supplied without an explicit -X. Track those to classify
    // such calls as non-idempotent.
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      hasApiBodyField = true
    } else if (
      a.startsWith('-f=') ||
      a.startsWith('-F=') ||
      a.startsWith('--field=') ||
      a.startsWith('--raw-field=')
    ) {
      hasApiBodyField = true
    }
    // `gh api graphql -f query=mutation(...){ ... }` — detect mutation queries
    // so writes via the GraphQL endpoint also fail fast on transient errors.
    if (a.startsWith('query=')) {
      hasGraphQlQuery = true
      const trimmed = a.slice('query='.length).trimStart().toLowerCase()
      if (trimmed.startsWith('mutation')) {
        return false
      }
    }
  }
  // `gh api ... -f foo=bar` with no explicit method: gh switches to POST.
  // Treat as non-idempotent so a transient 5xx after the server applied
  // the write doesn't retry and duplicate it. GraphQL reads are the exception:
  // gh sends them as POST body fields, but a query operation is idempotent.
  if (
    args[0] === 'api' &&
    hasApiBodyField &&
    !explicitMethodSeen &&
    !(isGraphQlApi && hasGraphQlQuery)
  ) {
    return false
  }
  // `gh issue close`, `gh pr edit`, `gh pr merge`, etc. The first arg is the
  // noun (issue/pr/repo/label/...) and the second is the verb. Defaulting
  // `gh api` calls without an explicit -X to GET-equivalent (idempotent) is
  // intentional: callers that POST through `gh api` set `-X POST`.
  if (args.length >= 2 && args[0] !== 'api') {
    if (NON_IDEMPOTENT_GH_VERBS.has(args[1])) {
      return false
    }
  }
  return true
}

/**
 * Extract stderr from an execFile rejection.
 *
 * Why: Node's execFile rejects with an Error that has `.stdout` and `.stderr`
 * fields populated separately from `.message`. Reading `err.message` alone is
 * unreliable — it can truncate stderr or omit it entirely depending on Node
 * version and maxBuffer behavior. We prefer the explicit fields and fall
 * back to `.message` only when neither is present.
 */
export function extractExecError(err: unknown): { stderr: string; stdout: string } {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const stderr =
      typeof e.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf-8')
          : ''
    const stdout =
      typeof e.stdout === 'string'
        ? e.stdout
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString('utf-8')
          : ''
    if (stderr || stdout) {
      return { stderr, stdout }
    }
    if (typeof e.message === 'string') {
      return { stderr: e.message, stdout: '' }
    }
  }
  return { stderr: String(err), stdout: '' }
}

/**
 * Detect a Retry-After hint in gh stderr and return the suggested delay in ms,
 * or null when the response includes no Retry-After.
 *
 * Why: gh forwards response headers when verbose, and prints "Retry-After:
 * <seconds>" in error output for primary rate-limit 429s. When present, the
 * caller is better served by propagating the error so the UI can surface the
 * real wait time — retrying on our own 250ms cadence just earns another 429
 * and burns the retry budget. Also supports HTTP-date Retry-After values.
 */
export function parseRetryAfterMs(stderr: string): number | null {
  const m = stderr.match(/retry-after:\s*([^\r\n]+)/i)
  if (!m) {
    return null
  }
  const raw = m[1].trim()
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }
  const ts = Date.parse(raw)
  if (Number.isNaN(ts)) {
    return null
  }
  return Math.max(0, ts - Date.now())
}

/**
 * Classify whether a gh execFile rejection is worth retrying.
 *
 * Why: gh surfaces HTTP status in stderr as "HTTP 504", "HTTP 502", etc.
 * Network resets and DNS hiccups also show up as stderr substrings. We retry
 * those and 429 (rate-limited) — but only 429s without an explicit
 * Retry-After (the caller is better off propagating so the UI can show the
 * actual wait time). The primary-rate-limit 403 branch is NOT retried: those
 * require the user to back off for minutes, which is not transient.
 */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  if (
    s.includes('http 500') ||
    s.includes('http 502') ||
    s.includes('http 503') ||
    s.includes('http 504') ||
    s.includes('econnreset') ||
    s.includes('etimedout') ||
    s.includes('socket hang up')
  ) {
    return true
  }
  // 429 without Retry-After: retry. With Retry-After: propagate.
  if (s.includes('http 429')) {
    return parseRetryAfterMs(stderr) === null
  }
  return false
}

// Why: total of 3 attempts (original + 2 retries) with 250ms → 1s backoff.
// These are standard "transient 5xx" values. Longer waits push past user
// patience for an interactive action; shorter waits would hammer the same
// unhealthy upstream that just failed. The array length defines retry count;
// total attempts = length + 1.
const GH_RETRY_DELAYS_MS = [250, 1000] as const

// Why: the upstream Retry-After header is server-suggested but unbounded —
// GitHub has been observed to send tens-of-seconds values on rare incidents,
// and a malicious or misconfigured proxy could send anything. Cap the wait
// at 30s so a single transient gh call can never block the IPC main thread
// for longer than the user's patience budget for an interactive action.
const GH_RETRY_AFTER_MAX_MS = 30_000

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 *
 * Retries transient 5xx / 429 (without Retry-After) / network-reset failures
 * with exponential backoff. Non-transient errors (auth, 404, rate-limit 403,
 * validation, 429-with-Retry-After) fail fast on the first attempt.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  let resolved = resolveCommand('gh', args, options.cwd, options.wslDistro)
  let lastError: unknown
  let attemptedHostFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        env: options.env
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (!attemptedHostFallback && canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
        resolved = resolveHostGitHubCli('gh', args)
        attemptedHostFallback = true
        attempt = -1
        continue
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      // Why: only retry idempotent calls. A 5xx/socket reset can arrive
      // after the server already applied a POST/PATCH/PUT/DELETE; retrying
      // would duplicate the write (e.g. double-post a comment, double-add
      // a label). When the caller doesn't say, we auto-detect from argv —
      // explicit `-X <method>` and GraphQL `query=mutation …` are treated
      // as non-idempotent. See bug-scan finding 1.
      const idempotent = options.idempotent ?? argsLookIdempotent(args)
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Why: when the upstream surfaced a Retry-After (e.g. on a transient
        // 5xx that GitHub explicitly recommends backing off for), honor it
        // instead of using our default backoff — sleeping less than the
        // server suggests just earns another failure and burns our retry
        // budget. Cap at GH_RETRY_AFTER_MAX_MS so a pathologically large
        // hint can't block IPC for minutes; if the real wait is longer, the
        // attempt will fail again and the error will propagate to the UI
        // where the user can see it.
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs)
        continue
      }
      throw err
    }
  }
  // Unreachable: the loop either returns or throws. Here for TS exhaustiveness.
  throw lastError
}

// ─── glab CLI runner ────────────────────────────────────────────────
// Why: parallel to gh CLI runner above. GitLab support is added by
// cloning gh's surface rather than abstracting both behind a generic
// runner — keeping them as parallel implementations matches the
// project's clone-and-adapt approach for new providers and avoids
// touching the working gh path. Reuses the shared retry/transient
// helpers since HTTP-status- and TCP-error-based classification is
// provider-agnostic.

type GlabExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
}

/**
 * Async glab CLI execution. Drop-in replacement for
 * `execFileAsync('glab', args, { cwd, encoding, ... })`.
 *
 * Retry policy mirrors ghExecFileAsync.
 */
export async function glabExecFileAsync(
  args: string[],
  options: GlabExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCommand('glab', args, options.cwd, options.wslDistro)
  let lastError: unknown
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        env: options.env
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      // Why: mirror gh's write-safety gate. A transient error after GitLab
      // applies a POST/PATCH/PUT/DELETE must not create duplicate comments,
      // issues, or merge actions through an automatic retry.
      const idempotent = options.idempotent ?? argsLookIdempotent(args)
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs)
        continue
      }
      throw err
    }
  }
  throw lastError
}

// ─── Generic command runner (for rg, etc.) ──────────────────────────

/**
 * Spawn any command with WSL awareness.
 * Used for non-git binaries like `rg` that also need WSL routing.
 */
export function wslAwareSpawn(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string }
): ChildProcess {
  const resolved = resolveCommand(command, args, options.cwd)
  return spawn(resolved.binary, resolved.args, {
    ...options,
    cwd: resolved.cwd
  })
}

// ─── Path translation helpers ───────────────────────────────────────

/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 *
 * Why: when git runs inside WSL, paths in output (e.g. `git worktree list`)
 * are Linux-native (/home/user/repo). The rest of Orca needs Windows UNC
 * paths (\\wsl.localhost\Ubuntu\home\user\repo) to read files via Node fs.
 */
export function translateWslOutputPaths(output: string, originalCwd: string): string {
  const wsl = parseWslPath(originalCwd)
  if (!wsl) {
    return output
  }

  // Replace absolute Linux paths that start with / and look like filesystem
  // paths in structured git output (e.g. "worktree /home/user/repo/feature")
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, linuxPath: string) =>
    toWindowsWslPath(linuxPath, wsl.distro)
  )
}

/**
 * Get the WSL info for a path, if applicable. Convenience re-export so
 * consumers don't need to import from wsl.ts directly.
 */
export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl'
