// Why: single seam that knows how to fetch raw git blob bytes. Strategy
// selection (CLI vs. native) lives here so status.ts keeps only
// result-shaping semantics.
import { gitExecFileAsyncBuffer } from './runner'
import { isMaxBufferOverflowError } from './max-buffer-overflow'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { loadGitNativeModule, type GitNativeModule } from './git-native-module'
import { isWslPath } from '../wsl'
import { track } from '../telemetry/client'

export const MAX_GIT_SHOW_BYTES = 10 * 1024 * 1024

// Mirrors NativeBlobResult but names the payload `bytes` (domain) vs its `data` (napi ABI); Task 8's native→raw adapter maps between them.
export type RawBlobOutcome = { found: boolean; tooLarge: boolean; bytes?: Buffer }

export type BlobReadRequest =
  | { kind: 'rev'; worktreePath: string; rev: string; gitPath: string }
  | { kind: 'index'; worktreePath: string; gitPath: string }

export type NativeGitMode = 'off' | 'shadow' | 'on'

export function resolveNativeGitMode(experimentalNativeGit: boolean | undefined): NativeGitMode {
  // Normalize once so a support instruction like "set ORCA_NATIVE_GIT=off"
  // works regardless of casing/whitespace.
  const env = process.env.ORCA_NATIVE_GIT?.trim().toLowerCase()
  // Kill switch: ORCA_NATIVE_GIT=0/off/false forces CLI reads regardless of
  // settings; =shadow dual-runs every read for verification (CI/dogfood);
  // =1 forces native on.
  if (env === '0' || env === 'off' || env === 'false') {
    return 'off'
  }
  if (env === 'shadow') {
    return 'shadow'
  }
  if (env === '1') {
    return 'on'
  }
  return experimentalNativeGit ? 'on' : 'off'
}

let modeResolver: () => NativeGitMode = () => resolveNativeGitMode(undefined)
let sessionPoisoned = false
let readCounter = 0
let divergenceEventsSent = 0
let divergenceLogged = false

// Why: in on-mode the first reads plus a 1/128 sample are re-run via CLI in the
// background and compared; one mismatch poisons the session back to CLI-only so
// a gix/git disagreement can never persist for a user. ONLY sampled reads are
// verified — unsampled native reads in `on` mode are served without a CLI
// cross-check, which is the accepted cost of `on` mode.
const ALWAYS_SAMPLE_FIRST_READS = 3
const SAMPLE_EVERY_NTH_READ = 128
const MAX_DIVERGENCE_EVENTS_PER_SESSION = 5

export function configureNativeGitBlobReads(resolver: () => NativeGitMode): void {
  modeResolver = resolver
}

export async function readGitBlobRaw(
  request: BlobReadRequest,
  options: GitRuntimeOptions = {}
): Promise<RawBlobOutcome> {
  const mode = modeResolver()
  const module = mode === 'off' ? null : loadGitNativeModule()
  if (!module || sessionPoisoned || !isNativeEligible(request.worktreePath, options)) {
    return readBlobViaCli(request, options)
  }
  if (mode === 'shadow') {
    const [nativeOutcome, cliOutcome] = await Promise.all([
      readBlobViaNative(module, request).catch(() => null),
      readBlobViaCli(request, options)
    ])
    if (nativeOutcome && !options.signal?.aborted) {
      compareAndRecord(request, nativeOutcome, cliOutcome)
    }
    return cliOutcome
  }
  let nativeOutcome: RawBlobOutcome
  try {
    nativeOutcome = await readBlobViaNative(module, request)
  } catch {
    return readBlobViaCli(request, options)
  }
  if (options.signal?.aborted) {
    // Why: the CLI path surfaces an abort as a rejected spawn that callers map
    // to found:false; mirror it so abort races behave identically.
    return { found: false, tooLarge: false }
  }
  maybeSampleVerify(request, nativeOutcome, options)
  return nativeOutcome
}

// Why: a wslDistro-routed read targets the distro's filesystem, not the host's,
// so native host reads are never valid for it — regardless of the host OS. A
// \\wsl.localhost UNC path is likewise a WSL repo (on Windows) whose native
// read would hit the slow 9p mount, so keep those on the existing CLI routing.
// SSH repos never reach here — the relay reads remotely.
function isNativeEligible(worktreePath: string, options: GitRuntimeOptions): boolean {
  if (options.wslDistro) {
    return false
  }
  if (process.platform === 'win32' && isWslPath(worktreePath)) {
    return false
  }
  return true
}

async function readBlobViaNative(
  module: GitNativeModule,
  request: BlobReadRequest
): Promise<RawBlobOutcome> {
  const result =
    request.kind === 'rev'
      ? await module.readBlobAtRevPath(
          request.worktreePath,
          request.rev,
          request.gitPath,
          MAX_GIT_SHOW_BYTES
        )
      : await module.readBlobAtIndexPath(request.worktreePath, request.gitPath, MAX_GIT_SHOW_BYTES)
  if (result.tooLarge) {
    return { found: true, tooLarge: true }
  }
  if (!result.found || !result.data) {
    return { found: false, tooLarge: false }
  }
  // Native type names the payload `data` (napi ABI); the seam uses `bytes`.
  return { found: true, tooLarge: false, bytes: result.data }
}

function maybeSampleVerify(
  request: BlobReadRequest,
  nativeOutcome: RawBlobOutcome,
  options: GitRuntimeOptions
): void {
  readCounter += 1
  const sampled =
    readCounter <= ALWAYS_SAMPLE_FIRST_READS || readCounter % SAMPLE_EVERY_NTH_READ === 0
  if (!sampled) {
    return
  }
  // Why: the verify spawn must not inherit the caller's abort signal — an
  // aborted CLI read would masquerade as a divergence.
  const { signal: _signal, ...verifyOptions } = options
  // Why: fire-and-forget runs with no unhandledRejection handler in main; the
  // trailing .catch guarantees a rejected verify (or a throwing compare) can
  // never surface as an unhandled rejection that could terminate the process.
  void readBlobViaCli(request, verifyOptions)
    .then((cliOutcome) => {
      compareAndRecord(request, nativeOutcome, cliOutcome)
    })
    .catch(() => {})
}

function compareAndRecord(
  request: BlobReadRequest,
  nativeOutcome: RawBlobOutcome,
  cliOutcome: RawBlobOutcome
): void {
  const divergence =
    nativeOutcome.found !== cliOutcome.found
      ? 'presence'
      : nativeOutcome.tooLarge !== cliOutcome.tooLarge
        ? 'too_large'
        : !buffersEqual(nativeOutcome.bytes, cliOutcome.bytes)
          ? 'bytes'
          : null
  if (!divergence) {
    return
  }
  sessionPoisoned = true
  if (!divergenceLogged) {
    // Why: telemetry is a hard no-op on dev/contributor builds, so a dogfooder
    // running ORCA_NATIVE_GIT=shadow/on would otherwise see native silently
    // poison off with no signal. This local log names the diverging file — a
    // path is fine in a LOCAL log; it must never enter the telemetry payload.
    divergenceLogged = true
    console.warn('[git-native] blob read diverged from git CLI; poisoning session to CLI-only', {
      read_kind: request.kind,
      divergence,
      file: `${request.worktreePath}:${request.gitPath}`
    })
  }
  if (divergenceEventsSent < MAX_DIVERGENCE_EVENTS_PER_SESSION) {
    divergenceEventsSent += 1
    // Telemetry stays path/content-free: only read kind and divergence class.
    try {
      track('git_native_shadow_divergence', { read_kind: request.kind, divergence })
    } catch {
      // Why: this runs inside a fire-and-forget verify chain with no
      // unhandledRejection handler in main; a throwing track() (posthog /
      // validate / getSettings have no internal guard) must never crash the
      // process. Poisoning is already set above, so dropping the event is safe.
    }
  }
}

function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (!a || !b) {
    return !a === !b
  }
  return a.equals(b)
}

async function readBlobViaCli(
  request: BlobReadRequest,
  options: GitRuntimeOptions
): Promise<RawBlobOutcome> {
  const args =
    request.kind === 'rev'
      ? ['show', '--end-of-options', `${request.rev}:${request.gitPath}`]
      : ['show', `:${request.gitPath}`]
  try {
    const { stdout } = await gitExecFileAsyncBuffer(args, {
      ...gitOptionsForWorktree(request.worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })
    return { found: true, tooLarge: false, bytes: stdout }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      // Why: overflow means the blob exists but exceeds the read cap; callers
      // treat it as present-but-unreadable, distinct from a missing path.
      return { found: true, tooLarge: true }
    }
    return { found: false, tooLarge: false }
  }
}

export function resetNativeGitBlobReadStateForTests(): void {
  modeResolver = () => resolveNativeGitMode(undefined)
  sessionPoisoned = false
  readCounter = 0
  divergenceEventsSent = 0
  divergenceLogged = false
}
