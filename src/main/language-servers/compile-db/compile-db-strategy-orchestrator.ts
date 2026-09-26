// Compile-db strategy orchestrator (spec D9 + §6): the db strategy that runs at
// session start. Detects a pre-existing compile_commands.json (reusing S1's
// detectExistingCompileCommandsDir); when none exists, generates one by project
// type — GN (`.gn` root marker) reuses the configured out dir's args.gn plus the
// export switch (断代: new `gn gen --add-export-compile-commands=//*`, old GN
// falls back to `ninja -t compdb -x`); CMake (CMakeLists.txt) configures one
// (presets win, else bare into build/orca-lsp). On success the db is pointed at
// explicitly via --compile-commands-dir; on failure a persistent degraded hint +
// actionable toast surface and a .clangd template is written (write-once). A
// listfile watcher (CMakeLists.txt / BUILD.gn+.gn) regenerates the db so
// navigation returns to full without restarting clangd. cl.exe-driven dbs get a
// `Compiler: clang-cl` injection (findings §8, no Remove list needed).
import { existsSync } from 'node:fs'
import type { watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { detectExistingCompileCommandsDir } from '../clangd-launch'
import {
  runCMakeConfigure,
  readDefaultCMakePreset,
  bareConfigureBuildDir
} from './compile-db-cmake-strategy'
import {
  detectConfiguredGnOutDir,
  probeGnAddExportCompileCommands,
  runGnCompileDbGeneration
} from './compile-db-gn-strategy'
import {
  buildClangdConfigForClangCl,
  buildClangdConfigDegradedTemplate,
  compileCommandsUsesClangCl,
  readCompileCommandEntries,
  writeClangdConfigIfAbsent
} from './clangd-config-writer'
import { createListfileWatcher } from './compile-db-listfile-watcher'
import {
  COMPILE_DB_DEGRADED_HINT,
  GN_BUILD_FILE,
  GN_NO_OUT_DIR_TOAST,
  GN_ROOT_MARKER,
  type CompileDbResolution,
  type CompileDbStrategy,
  type CompileDbStrategyHooks
} from './compile-db-strategy-types'
import type { runProcess } from '../../../shared/child-process/run-process'

const CMAKELISTS_FILENAME = 'CMakeLists.txt'

/** A generation step result fed to the shared outcome applier. */
type GenerationOutcome = {
  success: boolean
  stderr: string
  code: number | null
  /** Single-word kind for the failure toast prefix. */
  kind: 'CMake' | 'GN'
}

/**
 * Builds the strategy for one worktree. `resolve()` runs the db strategy once
 * (detect or generate) and returns the dir clangd should be pointed at; the
 * listfile watcher keeps regenerating in the background. `dispose()` tears the
 * watcher down.
 */
export function createCompileDbStrategy(
  worktreeRoot: string,
  hooks: CompileDbStrategyHooks,
  runProcessImpl: typeof runProcess,
  watchImpl?: typeof fsWatch
): CompileDbStrategy {
  const log = (line: string): void => hooks.onLog?.(line)

  // Shared success/failure side-effects for any generation path: on success,
  // inject clang-cl for an MSVC db and clear the degraded hint; on failure,
  // write the degraded template (write-once) + hint + actionable toast. The
  // caller picks the db dir and the generation command.
  const applyGenerationOutcome = async (
    step: () => Promise<GenerationOutcome>,
    dbDir: string
  ): Promise<CompileDbResolution> => {
    hooks.onStatus?.('clangd: configuring compile database')
    const outcome = await step()
    hooks.onStatus?.(null)
    if (outcome.success) {
      maybeInjectClangCl(worktreeRoot, dbDir)
      hooks.onDegraded?.(null)
      log(`[compile-db] ${outcome.kind} configured: ${dbDir}`)
      return { compileCommandsDir: dbDir, degraded: false }
    }
    writeClangdConfigIfAbsent(worktreeRoot, buildClangdConfigDegradedTemplate())
    hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
    hooks.onToast?.(degradedToastMessage(outcome.kind, outcome.stderr, outcome.code))
    log(
      `[compile-db] ${outcome.kind} configure failed: ${outcome.stderr || (outcome.code ?? 'timeout')}`
    )
    return { compileCommandsDir: dbDir, degraded: true }
  }

  const expectedCMakeBuildDir = (preset: ReturnType<typeof readDefaultCMakePreset>): string =>
    preset ? preset.binaryDir : bareConfigureBuildDir(worktreeRoot)

  const generateCMake = async (
    preset: ReturnType<typeof readDefaultCMakePreset>
  ): Promise<CompileDbResolution> =>
    applyGenerationOutcome(async () => {
      const r = await runCMakeConfigure(worktreeRoot, preset, runProcessImpl)
      return { success: r.success, stderr: r.stderr, code: r.code, kind: 'CMake' }
    }, expectedCMakeBuildDir(preset))

  const generateGn = async (
    outDir: string,
    addExportSupported: boolean
  ): Promise<CompileDbResolution> =>
    applyGenerationOutcome(async () => {
      const r = await runGnCompileDbGeneration(
        worktreeRoot,
        outDir,
        addExportSupported,
        runProcessImpl
      )
      const stderr =
        r.path === 'ninja-compdb' && r.outputTruncated ? 'compile db output truncated' : r.stderr
      return { success: r.success, stderr, code: r.code, kind: 'GN' }
    }, outDir)

  let watcher: ReturnType<typeof createListfileWatcher> | null = null

  const armWatcher = (
    filenames: readonly string[],
    regenerate: () => Promise<unknown>,
    recursive: boolean = false
  ): void => {
    if (watcher) {
      return
    }
    watcher = createListfileWatcher(
      worktreeRoot,
      filenames,
      () => {
        void regenerate()
      },
      () => log(`[compile-db] ${filenames.join('/')} watcher error — regeneration paused`),
      watchImpl,
      undefined,
      recursive
    )
  }

  const resolveGn = async (): Promise<CompileDbResolution> => {
    // A configured out dir (build.ninja) is the precondition. With one, probe
    // the 2022-09 断代 once and generate (new `gn gen` / old `ninja compdb`);
    // the BUILD.gn+.gn watcher regenerates. Without one, degrade and tell the
    // user to run `gn gen` first — never guess args.gn (spec D9).
    const outDir = detectConfiguredGnOutDir(worktreeRoot)
    if (!outDir) {
      hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
      hooks.onToast?.(GN_NO_OUT_DIR_TOAST)
      log('[compile-db] gn project has no configured out dir — ask user to run gn gen')
      return { compileCommandsDir: null, degraded: true }
    }
    const addExportSupported = await probeGnAddExportCompileCommands('gn', runProcessImpl)
    const resolution = await generateGn(outDir, addExportSupported)
    armWatcher([GN_BUILD_FILE, GN_ROOT_MARKER], () => generateGn(outDir, addExportSupported), true)
    return resolution
  }

  return {
    async resolve(): Promise<CompileDbResolution> {
      const existing = detectExistingCompileCommandsDir(worktreeRoot)
      if (existing) {
        hooks.onDegraded?.(null)
        return { compileCommandsDir: existing, degraded: false }
      }
      // GN project (`.gn` root marker wins — it exists iff GN is the build
      // system). CMake is the fallback when only CMakeLists.txt is present.
      if (existsSync(join(worktreeRoot, GN_ROOT_MARKER))) {
        return resolveGn()
      }
      if (existsSync(join(worktreeRoot, CMAKELISTS_FILENAME))) {
        const preset = readDefaultCMakePreset(worktreeRoot)
        const resolution = await generateCMake(preset)
        armWatcher([CMAKELISTS_FILENAME], () => generateCMake(preset))
        return resolution
      }
      // Not a CMake/GN project and no db: single-file navigation, no template.
      hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
      return { compileCommandsDir: null, degraded: true }
    },
    dispose(): void {
      watcher?.dispose()
      watcher = null
    }
  }
}

/** Inspects the generated db for a cl.exe driver and injects clang-cl. */
function maybeInjectClangCl(worktreeRoot: string, buildDir: string): void {
  const dbPath = join(buildDir, 'compile_commands.json')
  const entries = readCompileCommandEntries(dbPath)
  if (compileCommandsUsesClangCl(entries)) {
    // Write-once: a user's .clangd or a prior Orca write is never overwritten.
    writeClangdConfigIfAbsent(worktreeRoot, buildClangdConfigForClangCl())
  }
}

/** Actionable toast text for a configure failure (first stderr line). */
function degradedToastMessage(kind: 'CMake' | 'GN', stderr: string, code: number | null): string {
  const firstLine = stderr.split(/\r?\n/).find((line) => line.trim())
  const detail = firstLine ? ` — ${firstLine}` : code === null ? ' — timed out' : ''
  return `${kind} configure failed; navigation is limited to single-file${detail}`
}
