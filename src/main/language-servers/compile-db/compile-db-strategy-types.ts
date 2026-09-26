// Shared types + constants for the compile-database strategy layer (spec §4 +
// D9). Split out so each strategy module (CMake here, GN in ticket 18, degraded
// fallback) stays under its line budget and the seam for GN stays explicit.
import type { runProcess } from '../../../shared/child-process/run-process'

/**
 * Persistent degraded hint shown when no compile database is available — clangd
 * still starts, but navigation is limited to the active file (spec §6).
 */
export const COMPILE_DB_DEGRADED_HINT = '降级：无编译数据库，导航限于单文件'

/**
 * Standalone build directory Orca configures into when a CMake project has no
 * presets and no pre-existing compile_commands.json (spec D9). Never the repo
 * root — an explicit `--compile-commands-dir` beats a root-level symlink
 * (Windows symlinks need dev mode/admin; spike findings §8).
 */
export const ORCA_LSP_BUILD_DIR_SEGMENTS = ['build', 'orca-lsp'] as const

/** CMakePresets files checked, in priority order, for a default preset. */
export const CMAKE_PRESETS_FILES = ['CMakePresets.json', 'CMakeUserPresets.json'] as const

/** The CMake flag that makes `configure` emit `compile_commands.json`. */
export const CMAKE_EXPORT_COMPILE_COMMANDS_FLAG = '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'

/** Bound on a single CMake configure; a wedged configure must not hang clangd. */
export const CMAKE_CONFIGURE_TIMEOUT_MS = 120_000

/**
 * The `gn gen` flag that makes GN emit `compile_commands.json` (spec D9). The
 * `2022-09` 断代: old GN has only `--export-compile-commands`; new GN added
 * `--add-export-compile-commands=<pattern>` and silently ignores the old one.
 * `//*` matches every target (db bigger but complete — no navigation blind
 * spots). Research/04 §1.1 + §4.
 */
export const GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG = '--add-export-compile-commands'

/** Pattern matching every GN target — a complete db, no blind-spot targets. */
export const GN_EXPORT_ALL_TARGETS_PATTERN = '//*'

/** Ninja compdb language rules GN edges carry (cc/cxx/objc/objcxx). */
export const NINJA_COMPDB_RULES = ['cc', 'cxx', 'objc', 'objcxx'] as const

/** The ninja flag that inlines `@rsp` files; required on Windows, harmless elsewhere. */
export const NINJA_COMPDB_EXPAND_RSP_FLAG = '-x'

/** GN's root-config marker — its presence means the worktree is a GN project. */
export const GN_ROOT_MARKER = '.gn'

/** GN's per-dir build file; edits re-trigger db regeneration (spec D9). */
export const GN_BUILD_FILE = 'BUILD.gn'

/** The file GN writes into a configured out dir; its presence means `gn gen` ran. */
export const GN_BUILD_NINJA_FILENAME = 'build.ninja'

/** Bound on one `gn gen` / `ninja -t compdb`; a wedge must not hang clangd. */
export const GN_CONFIGURE_TIMEOUT_MS = 60_000

/** Toast for a GN project with no configured out dir (spec D9: don't guess args.gn). */
export const GN_NO_OUT_DIR_TOAST =
  'GN 项目尚未配置 out 目录：先运行 `gn gen <out>`（如 `gn gen out/Default`）生成 build.ninja，再重新打开文件以启用导航'

export type CompileDbStrategyHooks = {
  /** Transient status projection (e.g. "configuring compile database"); null clears. */
  onStatus?: (text: string | null) => void
  /** Persistent degraded hint; null clears (spec §6). */
  onDegraded?: (message: string | null) => void
  /** One-shot actionable notification (configure failure). */
  onToast?: (message: string) => void
  onLog?: (line: string) => void
}

export type CompileDbResolution = {
  /**
   * Absolute directory passed to clangd as `--compile-commands-dir`, or null
   * when clangd should run without one (single-file navigation).
   */
  compileCommandsDir: string | null
  /** True when no usable compile database is available (degraded experience). */
  degraded: boolean
}

/**
 * A compile-db strategy for one worktree: `resolve()` runs once at session
 * start (detect or generate), `dispose()` tears down the regenerate watcher.
 * The CMake strategy (this slice) and the GN strategy (ticket 18) both fit.
 */
export type CompileDbStrategy = {
  resolve(): Promise<CompileDbResolution>
  dispose(): void
}

/** A CMake configure preset selected as the default for a project. */
export type CMakePresetSelection = {
  name: string
  /** Absolute binary directory where the generated db will land. */
  binaryDir: string
}

/** Injected so tests can stub cmake without touching the real binary. */
export type CMakeRunner = typeof runProcess

/** Injected so tests can stub gn/ninja without touching the real binaries. */
export type GnRunner = typeof runProcess
