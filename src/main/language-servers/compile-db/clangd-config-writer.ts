// .clangd config writer (spec D9 + research/09 §8). Two write-once contents:
// (a) a `Compiler: clang-cl` injection when the compile db drives the native
// MSVC `cl.exe` — clang-cl handles every MSVC flag, so NO Remove flag list is
// needed (findings §8 proved this, 0 errors); (b) a degraded template (marker
// header + `CompileFlags.CompilationDatabase` pointer skeleton) written only
// when configure failed. Either content is written ONLY when no .clangd
// already exists — a user's config, or Orca's own prior write, is never
// overwritten.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const CLANGD_CONFIG_FILENAME = '.clangd'

/** Marker header that flags an Orca-managed file; safe for users to edit. */
export const ORCA_CLANGD_CONFIG_MARKER = '# Orca-managed clangd config (write-once; safe to edit)'

/** One compile_commands.json entry (subset clangd/JSON Compilation Database). */
export type CompileCommandEntry = {
  directory: string
  file: string
  /** Shell-argument form (preferred by clangd when present). */
  arguments?: readonly string[]
  /** Command-line string form (alternative to `arguments`). */
  command?: string
}

/**
 * `.clangd` content for a cl.exe-driven db: swap the driver to clang-cl so
 * clangd parses MSVC flags natively. No `Remove` list — findings §8 showed
 * clang-cl consumes every MSVC flag with 0 diagnostic errors.
 */
export function buildClangdConfigForClangCl(): string {
  return `${ORCA_CLANGD_CONFIG_MARKER}\nCompileFlags:\n  Compiler: clang-cl\n`
}

/**
 * `.clangd` template for the degraded (no db) state: a pointer skeleton the
 * user can fill in. Written only when configure failed and no config exists.
 */
export function buildClangdConfigDegradedTemplate(): string {
  return `${ORCA_CLANGD_CONFIG_MARKER}\nCompileFlags:\n  CompilationDatabase: <path-to-build-dir>\n`
}

/**
 * Write-once guard: writes `content` to `<dir>/.clangd` only when no `.clangd`
 * already exists there. Returns true when written, false when a config (user's
 * or Orca's own) was already present and left untouched.
 */
export function writeClangdConfigIfAbsent(dir: string, content: string): boolean {
  const path = join(dir, CLANGD_CONFIG_FILENAME)
  if (existsSync(path)) {
    return false
  }
  writeFileSync(path, content)
  return true
}

/**
 * True when any db entry's `argv[0]` is the native MSVC `cl.exe`. The basename
 * check excludes `clang-cl.exe` (whose basename differs) — research/09 §8
 * targeted the MSVC driver specifically.
 */
export function compileCommandsUsesClangCl(entries: readonly CompileCommandEntry[]): boolean {
  for (const entry of entries) {
    const argv0 = entry.arguments?.[0] ?? firstToken(entry.command)
    if (argv0 && basename(argv0).toLowerCase() === 'cl.exe') {
      return true
    }
  }
  return false
}

/** Read a JSON Compilation Database file into entries, or [] when unreadable. */
export function readCompileCommandEntries(dbPath: string): CompileCommandEntry[] {
  if (!existsSync(dbPath)) {
    return []
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parse result is unknown; validated to an array and each entry's fields read through optional chaining.
    const parsed = JSON.parse(readFileSync(dbPath, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as CompileCommandEntry[]) : []
  } catch {
    return []
  }
}

function firstToken(command: string | undefined): string | undefined {
  if (!command) {
    return undefined
  }
  const token = command.split(/\s+/)[0]
  return token || undefined
}
