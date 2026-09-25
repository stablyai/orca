// Host-adapter abstraction for language-server navigation (spec §4 + D5/D8).
// The three execution hosts — native (Windows/macOS/Linux local), WSL, and SSH
// (ticket 17) — share one LSP client and session machinery; the per-host seam
// is how to spawn clangd and how to map Orca file identity <-> LSP `file:`
// URI. This interface bundles that seam so `clangd-session.ts` and
// `language-server-host.ts` stay host-agnostic.
//
// Native paths use `file:///D:/…` (drive) or `file:///home/…` (POSIX); WSL
// maps the Windows UNC form (`\\wsl.localhost\<distro>\…`) to the guest POSIX
// path (`file:///home/…`) so clangd running inside the guest sees its own
// filesystem. SSH (later) maps POSIX + connectionId to the remote path.
import type { spawnProcess } from '../../shared/child-process/run-process'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { ClangdLaunchOptions, ClangdVersionGateResult } from './clangd-launch'
import type { NativeLanguageServerProcessHandlers } from './native-language-server-process'
import type { CompileDbStrategy, CompileDbStrategyHooks } from './language-server-host-types'
import { wslNormalizeKey } from './wsl-path-mapping'
import { createNativeHostAdapter } from './native-language-server-adapter'
import { createWslHostAdapter } from './wsl-language-server-adapter'

/** Full launch spec for the long-lived clangd process (program + argv + cwd + env). */
export type LanguageServerProcessLaunch = {
  program: string
  args: readonly string[]
  /** Windows-side cwd for the spawned process; the guest cwd is encoded in argv for WSL. */
  cwd: string
  /** Host env; WSL sets WSL_UTF8 here, native omits (inherits process.env). */
  env?: NodeJS.ProcessEnv
}

/** Re-exported so the session can type the process handle without importing native-only names. */
export type LanguageServerProcessHandle = {
  readonly pid: number | undefined
  readonly exited: Promise<boolean>
  write(bytes: Buffer): void
  endStdin(): void
  killTree(): Promise<boolean>
}

/** Re-exported handler shape (shared by native + WSL process adapters). */
export type LanguageServerProcessHandlers = NativeLanguageServerProcessHandlers

/**
 * The per-host seam. The session calls `openProcess` with the launch the
 * adapter built, and `pathToLspUri`/`lspUriToPath`/`normalizeKey` for every
 * file identity <-> URI round trip. `resolveClangdProgram`/`resolveVersionGate`
 * locate and classify the binary on the host (native PATH or guest PATH).
 * `buildLaunch` resolves any async host data (WSL guest env + clangd path)
 * before returning the full launch spec. `createDbStrategy` supplies the
 * compile-db strategy appropriate to the host (native: CMake generation; WSL:
 * detection-only — guest cmake is out of scope for ticket 16).
 */
export type LanguageServerHostAdapter = {
  readonly kind: 'native' | 'wsl'
  /** Canonical session/document key for an Orca file identity (case-folds UNC prefixes for WSL). */
  normalizeKey(filePath: string): string
  /** Orca file identity -> LSP document URI (host-local path form). */
  pathToLspUri(filePath: string): string
  /** LSP document URI -> Orca file identity (reverse map; WSL needs the distro). */
  lspUriToPath(uri: string): string
  /** Resolve the clangd binary path (native PATH or guest PATH lookup); used for logging. */
  resolveClangdProgram(): string
  /** Probe + classify the clangd version gate (<12 reject, 12-15 advise, >=16 ok). */
  resolveClangdVersionGate(program: string): Promise<ClangdVersionGateResult>
  /** Build the full clangd launch spec (async: WSL resolves guest env + clangd path). */
  buildLaunch(
    worktreeRoot: string,
    opts?: ClangdLaunchOptions
  ): Promise<LanguageServerProcessLaunch>
  /** Spawn the long-lived clangd process; returns the stdio handle. */
  openProcess(
    launch: LanguageServerProcessLaunch,
    handlers: LanguageServerProcessHandlers,
    spawnImpl?: typeof spawnProcess
  ): LanguageServerProcessHandle
  /** Compile-db strategy for this host (native: CMake; WSL: detection-only). */
  createDbStrategy(worktreeRoot: string, hooks: CompileDbStrategyHooks): CompileDbStrategy
}

/** Re-export the launch-options type so importers reach it from one place. */
export type { ClangdLaunchOptions } from './clangd-launch'

/**
 * Universal file-identity key for the host's session/document tables. Handles
 * every path shape Orca routes: WSL UNC (case-folds the wsl.localhost/distro
 * prefix), Windows drive (uppercases the letter), and POSIX (passthrough).
 * The session key and the document key must use the same rule so routing is
 * stable across separator/case spellings of the same file (spec D5).
 */
export function normalizeHostFileKey(filePath: string): string {
  // Delegates to the WSL normalizer, which folds UNC prefixes and falls back
  // to native drive normalization for everything else — so a single rule
  // covers native + WSL (SSH adds connectionId scoping in ticket 17).
  return wslNormalizeKey(filePath)
}

const nativeAdapter = createNativeHostAdapter()
const wslAdaptersByDistro = new Map<string, LanguageServerHostAdapter>()

/**
 * Select the host adapter for a worktree root. A WSL UNC path yields the WSL
 * adapter bound to the distro (memoized per distro so probe results are
 * shared across sessions); everything else uses the stateless native adapter.
 */
export function selectHostAdapter(worktreeRoot: string): LanguageServerHostAdapter {
  const distro = parseWslUncPath(worktreeRoot)?.distro ?? null
  if (!distro) {
    return nativeAdapter
  }
  let adapter = wslAdaptersByDistro.get(distro)
  if (!adapter) {
    adapter = createWslHostAdapter(distro)
    wslAdaptersByDistro.set(distro, adapter)
  }
  return adapter
}

/** Test seam: forget memoized WSL adapters (guest installs change without restart). */
export function resetHostAdapterCacheForTests(): void {
  wslAdaptersByDistro.clear()
}
