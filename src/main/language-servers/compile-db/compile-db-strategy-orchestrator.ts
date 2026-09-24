// Compile-db strategy orchestrator (spec D9 + §6): the db strategy that runs at
// session start. Detects a pre-existing compile_commands.json (reusing S1's
// detectExistingCompileCommandsDir); when none exists, CMake-configures one
// (presets win, else bare into build/orca-lsp). On success the resulting db is
// pointed at explicitly via --compile-commands-dir; on failure a persistent
// degraded hint + actionable toast surface and a .clangd template is written
// (write-once). A CMakeLists.txt watcher regenerates the db so navigation
// returns to full without restarting clangd (clangd reloads the db file itself).
// cl.exe-driven dbs get a `Compiler: clang-cl` injection (findings §8, no Remove
// list needed). GN is ticket 18 — this is the seam it extends.
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
  buildClangdConfigForClangCl,
  buildClangdConfigDegradedTemplate,
  compileCommandsUsesClangCl,
  readCompileCommandEntries,
  writeClangdConfigIfAbsent
} from './clangd-config-writer'
import { createCMakeListfileWatcher } from './compile-db-cmake-listfile-watcher'
import {
  COMPILE_DB_DEGRADED_HINT,
  type CompileDbResolution,
  type CompileDbStrategy,
  type CompileDbStrategyHooks
} from './compile-db-strategy-types'
import type { runProcess } from '../../../shared/child-process/run-process'

const CMAKELISTS_FILENAME = 'CMakeLists.txt'

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

  const expectedBuildDir = (preset: ReturnType<typeof readDefaultCMakePreset>): string =>
    preset ? preset.binaryDir : bareConfigureBuildDir(worktreeRoot)

  // Runs a CMake configure, applies degraded/cl.exe side effects, and returns
  // the resolution. Used both for the initial resolve and the regenerate path.
  const generate = async (
    preset: ReturnType<typeof readDefaultCMakePreset>
  ): Promise<CompileDbResolution> => {
    hooks.onStatus?.('clangd: configuring compile database')
    const outcome = await runCMakeConfigure(worktreeRoot, preset, runProcessImpl)
    hooks.onStatus?.(null)
    const buildDir = expectedBuildDir(preset)
    if (outcome.success) {
      maybeInjectClangCl(worktreeRoot, buildDir)
      hooks.onDegraded?.(null)
      log(`[compile-db] cmake configured: ${buildDir}`)
      return { compileCommandsDir: buildDir, degraded: false }
    }
    // Degraded: write the template fallback (write-once) and surface the hint.
    writeClangdConfigIfAbsent(worktreeRoot, buildClangdConfigDegradedTemplate())
    hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
    hooks.onToast?.(degradedToastMessage(outcome.stderr))
    log(`[compile-db] cmake configure failed: ${outcome.stderr || (outcome.code ?? 'timeout')}`)
    return { compileCommandsDir: buildDir, degraded: true }
  }

  const regenerate = async (preset: ReturnType<typeof readDefaultCMakePreset>): Promise<void> => {
    // Regeneration reuses the same preset/build-dir so the db lands where
    // clangd already looks — clangd's own db-file watch reloads it, so a
    // restart is unnecessary (spec D9).
    await generate(preset)
  }

  let watcher: ReturnType<typeof createCMakeListfileWatcher> | null = null

  return {
    async resolve(): Promise<CompileDbResolution> {
      const existing = detectExistingCompileCommandsDir(worktreeRoot)
      if (existing) {
        hooks.onDegraded?.(null)
        return { compileCommandsDir: existing, degraded: false }
      }
      const hasCMakeLists = existsSync(join(worktreeRoot, CMAKELISTS_FILENAME))
      if (!hasCMakeLists) {
        // Not a CMake project and no db: single-file navigation, no template.
        hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
        return { compileCommandsDir: null, degraded: true }
      }
      const preset = readDefaultCMakePreset(worktreeRoot)
      const resolution = await generate(preset)
      // Arm the regenerator only when this is a CMake project (a db to refresh).
      if (!watcher) {
        watcher = createCMakeListfileWatcher(
          worktreeRoot,
          () => {
            void regenerate(preset)
          },
          () => log('[compile-db] CMakeLists.txt watcher error — regeneration paused'),
          watchImpl
        )
      }
      return resolution
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
function degradedToastMessage(stderr: string): string {
  const firstLine = stderr.split(/\r?\n/).find((line) => line.trim())
  const detail = firstLine ? ` — ${firstLine}` : ''
  return `CMake configure failed; navigation is limited to single-file${detail}`
}
