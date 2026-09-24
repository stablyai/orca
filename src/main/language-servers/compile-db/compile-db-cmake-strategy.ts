// CMake compile-database strategy (spec D9): for a project with no pre-existing
// compile_commands.json, auto-configure with CMAKE_EXPORT_COMPILE_COMMANDS=ON.
// Presets (CMakePresets.json/CMakeUserPresets.json) win when present; otherwise
// a bare configure lands in a standalone build/orca-lsp dir so Orca never
// touches the user's own build tree. The resulting db is pointed at explicitly
// via --compile-commands-dir — never a repo-root symlink (Windows symlinks need
// dev mode/admin; spike findings §8).
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { runProcess } from '../../../shared/child-process/run-process'
import {
  CMAKE_CONFIGURE_TIMEOUT_MS,
  CMAKE_EXPORT_COMPILE_COMMANDS_FLAG,
  CMAKE_PRESETS_FILES,
  ORCA_LSP_BUILD_DIR_SEGMENTS,
  type CMakePresetSelection
} from './compile-db-strategy-types'

/** argv for a bare configure into build/orca-lsp (cwd = worktree root). */
export function buildBareCMakeConfigureArgs(): readonly string[] {
  return ['-S', '.', '-B', join(...ORCA_LSP_BUILD_DIR_SEGMENTS), CMAKE_EXPORT_COMPILE_COMMANDS_FLAG]
}

/** argv for a preset-driven configure (the preset owns its binaryDir). */
export function buildPresetCMakeConfigureArgs(presetName: string): readonly string[] {
  return ['--preset', presetName]
}

/** Absolute dir the bare configure writes compile_commands.json into. */
export function bareConfigureBuildDir(worktreeRoot: string): string {
  return join(worktreeRoot, ...ORCA_LSP_BUILD_DIR_SEGMENTS)
}

type RawPresetFile = {
  configurePresets?: readonly {
    name?: string
    hidden?: boolean
    binaryDir?: string
  }[]
}

type RawPresetEntry = NonNullable<RawPresetFile['configurePresets']>[number]

/**
 * Resolves a preset's `binaryDir` to an absolute path. CMake presets support
 * `${sourceDir}` (and a few siblings); only `${sourceDir}` is expanded here —
 * it covers every real-world preset, and a relative dir falls back to the
 * worktree root as CMake does for non-macro values.
 */
function resolvePresetBinaryDir(raw: string, worktreeRoot: string): string {
  // ${sourceDir} expands to the native worktree root; a trailing macro leaves
  // the rest of the path with the preset's own separators, so normalize to the
  // platform form. A relative (non-macro) dir falls back to the worktree root.
  const expanded = raw.replace(/\$\{sourceDir\}/g, worktreeRoot)
  return isAbsolute(expanded) ? normalize(expanded) : join(worktreeRoot, expanded)
}

/**
 * Picks the default configure preset: the first non-hidden `configurePresets`
 * entry across CMakePresets.json then CMakeUserPresets.json. Returns null when
 * no presets file exists, the file is malformed, or it carries no presets.
 */
export function readDefaultCMakePreset(worktreeRoot: string): CMakePresetSelection | null {
  for (const file of CMAKE_PRESETS_FILES) {
    const path = join(worktreeRoot, file)
    if (!existsSync(path)) {
      continue
    }
    let parsed: RawPresetFile
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parse result is unknown; narrowed to RawPresetFile and every field read through optional chaining, so a malformed file degrades to "no presets".
      parsed = JSON.parse(readFileSync(path, 'utf8')) as RawPresetFile
    } catch {
      continue
    }
    const entry = pickFirstUsablePreset(parsed.configurePresets)
    if (entry) {
      const binaryDir = resolvePresetBinaryDir(entry.binaryDir ?? '', worktreeRoot)
      if (entry.name && binaryDir) {
        return { name: entry.name, binaryDir }
      }
    }
  }
  return null
}

function pickFirstUsablePreset(
  presets: readonly RawPresetEntry[] | undefined
): RawPresetEntry | null {
  if (!Array.isArray(presets)) {
    return null
  }
  for (const entry of presets) {
    if (entry && entry.hidden !== true && typeof entry.name === 'string') {
      return entry
    }
  }
  return null
}

export type CMakeConfigureOutcome = ProcessResult & {
  /** True when configure produced (or would produce) a usable db (exit 0). */
  success: boolean
}

/**
 * Runs `cmake` to generate the compile database. Never rejects; a non-zero exit
 * or timeout resolves to a failed outcome whose stderr feeds the degraded
 * toast. All subprocess spawning goes through `runProcess` (AGENTS.md ratchet).
 */
export async function runCMakeConfigure(
  worktreeRoot: string,
  preset: CMakePresetSelection | null,
  runProcessImpl: typeof runProcess
): Promise<CMakeConfigureOutcome> {
  const args = preset ? buildPresetCMakeConfigureArgs(preset.name) : buildBareCMakeConfigureArgs()
  const result = await runProcessImpl({
    program: 'cmake',
    args,
    cwd: worktreeRoot,
    timeoutMs: CMAKE_CONFIGURE_TIMEOUT_MS
  })
  return { ...result, success: result.code === 0 && !result.timedOut }
}
