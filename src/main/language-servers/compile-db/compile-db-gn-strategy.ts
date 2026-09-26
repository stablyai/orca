// GN compile-database strategy (spec D9 + research/04): reuse a configured out
// dir's args.gn + the export switch to regenerate the db; old GN falls back to
// `ninja -t compdb -x`; no out dir -> degrade and ask the user to run `gn gen`.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import { runProcess } from '../../../shared/child-process/run-process'
import {
  GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG,
  GN_BUILD_NINJA_FILENAME,
  GN_CONFIGURE_TIMEOUT_MS,
  GN_EXPORT_ALL_TARGETS_PATTERN,
  NINJA_COMPDB_EXPAND_RSP_FLAG,
  NINJA_COMPDB_RULES,
  type GnRunner
} from './compile-db-strategy-types'

/**
 * Pure 2022-09 断代: true when the `gn gen` help output advertises the
 * `--add-export-compile-commands` switch. Old GN lists only the deprecated
 * `--export-compile-commands` and silently ignores the new flag, so its absence
 * routes to the `ninja -t compdb -x` fallback (research/04 §1.1 + §4). Feature
 * detection on the help text beats a magic revision cutoff — GN's `--version`
 * prints a revision count with no published boundary table for this switch.
 */
export function gnHelpOffersAddExportCompileCommands(helpOutput: string): boolean {
  return helpOutput.includes(GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG)
}

/**
 * argv for new-GN db generation: `gen <out> --add-export-compile-commands=//*`.
 * Reuses the out dir's existing args.gn (low-risk); `//*` matches every target
 * so no file is a navigation blind spot (spec D9).
 */
export function buildGnGenArgs(outDir: string): readonly string[] {
  return ['gen', outDir, `${GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG}=${GN_EXPORT_ALL_TARGETS_PATTERN}`]
}

/**
 * argv for the old-GN fallback: `ninja -C <out> -t compdb -x cc cxx objc objcxx`.
 * `-x` inlines @rsp files — required on Windows (GN/MSVC edges carry @rsp), and
 * harmless elsewhere (Chromium's generate_compdb.py always passes it). The db
 * is written to stdout by ninja, so the runner redirects it to a file.
 */
export function buildNinjaCompdbArgs(outDir: string): readonly string[] {
  return ['-C', outDir, '-t', 'compdb', NINJA_COMPDB_EXPAND_RSP_FLAG, ...NINJA_COMPDB_RULES]
}

/** Curated out-dir candidates checked for `build.ninja`, in priority order. */
const GN_OUT_DIR_CANDIDATES = ['out', 'out/Default', 'out/Debug', 'out/Release', 'build'] as const

/**
 * Detects a configured GN out dir by its `build.ninja` marker (spec D9
 * precondition: "已有配置 out 目录"). Checks the worktree root, a curated set of
 * common out dirs (`out`, `out/Default`, `out/Debug`, `out/Release`, `build`),
 * then any other immediate subdirectory of `out/` — so a user's custom
 * `out/my-config` is still found without guessing args.gn. Returns the absolute
 * dir, or null when no `build.ninja` exists (caller degrades).
 */
export function detectConfiguredGnOutDir(worktreeRoot: string): string | null {
  const hasBuildNinja = (dir: string): boolean => existsSync(join(dir, GN_BUILD_NINJA_FILENAME))

  if (hasBuildNinja(worktreeRoot)) {
    return worktreeRoot
  }
  const checked = new Set<string>([worktreeRoot])
  for (const candidate of GN_OUT_DIR_CANDIDATES) {
    const dir = join(worktreeRoot, candidate)
    if (checked.has(dir)) {
      continue
    }
    checked.add(dir)
    if (hasBuildNinja(dir)) {
      return dir
    }
  }
  // Custom out/<name>: scan immediate subdirs of `out/` (sorted for determinism).
  const outRoot = join(worktreeRoot, 'out')
  if (existsSync(outRoot) && statSync(outRoot).isDirectory()) {
    let entries: readonly string[] = []
    try {
      entries = readdirSync(outRoot)
    } catch {
      entries = []
    }
    for (const name of [...entries].sort()) {
      const dir = join(outRoot, name)
      if (checked.has(dir)) {
        continue
      }
      checked.add(dir)
      try {
        if (statSync(dir).isDirectory() && hasBuildNinja(dir)) {
          return dir
        }
      } catch {
        // A non-dir entry or a race: skip.
      }
    }
  }
  return null
}

/** Runs `gn help gen` and reports whether the new export switch is advertised. */
export async function probeGnAddExportCompileCommands(
  gnProgram: string,
  runProcessImpl: GnRunner = runProcess
): Promise<boolean> {
  let result: ProcessResult
  try {
    result = await runProcessImpl({
      program: gnProgram,
      args: ['help', 'gen'],
      timeoutMs: GN_CONFIGURE_TIMEOUT_MS
    })
  } catch {
    // gn missing or unstartable: assume old -> ninja compdb fallback (safe).
    return false
  }
  if (result.timedOut || result.code !== 0) {
    return false
  }
  return gnHelpOffersAddExportCompileCommands(result.stdout)
}

export type GnCompileDbOutcome = ProcessResult & {
  /** True when the db file is usable (gn gen exit 0, or ninja stdout captured). */
  success: boolean
  /** Which path ran, for logging. */
  path: 'gn-gen' | 'ninja-compdb'
  /** True when ninja compdb stdout was clipped by maxOutputBytes (db unusable). */
  outputTruncated: boolean
}

/**
 * Generates the compile db into the out dir. New GN (`addExportSupported`)
 * runs `gn gen` (writes `compile_commands.json` in place); old GN runs
 * `ninja -t compdb -x` (db to stdout, captured to `<out>/compile_commands.json`).
 * Never rejects; a non-zero exit/timeout resolves to a failed outcome whose
 * stderr feeds the degraded toast.
 */
export async function runGnCompileDbGeneration(
  worktreeRoot: string,
  outDir: string,
  addExportSupported: boolean,
  runProcessImpl: GnRunner = runProcess
): Promise<GnCompileDbOutcome> {
  if (addExportSupported) {
    const result = await runProcessImpl({
      program: 'gn',
      args: buildGnGenArgs(outDir),
      cwd: worktreeRoot,
      timeoutMs: GN_CONFIGURE_TIMEOUT_MS
    })
    return {
      ...result,
      success: result.code === 0 && !result.timedOut,
      path: 'gn-gen',
      outputTruncated: false
    }
  }
  // Old-GN fallback: ninja writes the db to stdout; capture and land it as a file.
  const result = await runProcessImpl({
    program: 'ninja',
    args: buildNinjaCompdbArgs(outDir),
    cwd: worktreeRoot,
    timeoutMs: GN_CONFIGURE_TIMEOUT_MS
  })
  const usable = result.code === 0 && !result.timedOut && !result.outputTruncated
  if (usable) {
    writeCompileCommandsFromNinjaStdout(outDir, result.stdout)
  }
  return {
    ...result,
    success: usable,
    path: 'ninja-compdb',
    outputTruncated: result.outputTruncated === true
  }
}

/** Writes ninja compdb stdout to `<outDir>/compile_commands.json` (idempotent). */
function writeCompileCommandsFromNinjaStdout(outDir: string, stdout: string): void {
  writeFileSync(join(outDir, 'compile_commands.json'), stdout)
}
