// SSH compile-db strategy (spec D9 + §6): detection-only. clangd runs on the
// remote SSH host, so a pre-existing `compile_commands.json` is read through
// the SSH filesystem provider (relay `fs.*`), and the resolved dir is pointed
// at explicitly via `--compile-commands-dir` in remote POSIX form. CMake
// generation on the remote host is out of scope for ticket 17 (the host
// adapter's job is spawn + path mapping + lifecycle + version gate); when no
// db exists, clangd degrades to single-file navigation (spec §6) — which still
// yields hover/definition/references within the active file.
import { join } from 'node:path'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import {
  COMPILE_DB_DEGRADED_HINT,
  type CompileDbResolution,
  type CompileDbStrategy,
  type CompileDbStrategyHooks
} from './compile-db-strategy-types'

const COMPILE_DB_STAT_TIMEOUT_MS = 8_000

/**
 * Detection-only compile-db strategy for an SSH worktree. Walks up from the
 * worktree root looking for a `compile_commands.json` (build/, ./, or a
 * sibling build dir) via the SSH filesystem provider; the resolved dir is
 * handed to clangd in remote POSIX form. No remote CMake generation lane yet.
 */
export function createSshCompileDbStrategy(
  targetId: string,
  worktreeRoot: string,
  hooks: CompileDbStrategyHooks
): CompileDbStrategy {
  return {
    async resolve(): Promise<CompileDbResolution> {
      const provider = getSshFilesystemProvider(targetId)
      if (!provider) {
        // Transport loss — degrade, not a hard failure; re-probe on reconnect.
        hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
        return { compileCommandsDir: null, degraded: true }
      }
      const dir = await detectSshCompileCommandsDir(provider, worktreeRoot)
      if (dir) {
        hooks.onDegraded?.(null)
        return { compileCommandsDir: dir, degraded: false }
      }
      hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
      return { compileCommandsDir: null, degraded: true }
    },
    dispose(): void {
      // No watcher — detection is a single stat pass.
    }
  }
}

/**
 * Walk up from the worktree root, statting candidate `compile_commands.json`
 * locations (build/, then the root itself) via the SSH filesystem provider.
 * Returns the directory (POSIX) that contains the db, or null.
 */
async function detectSshCompileCommandsDir(
  provider: NonNullable<ReturnType<typeof getSshFilesystemProvider>>,
  worktreeRoot: string
): Promise<string | null> {
  const candidates = [join(worktreeRoot, 'build'), worktreeRoot]
  for (const dir of candidates) {
    const dbPath = join(dir, 'compile_commands.json')
    try {
      const stat = await Promise.race([
        provider.stat(dbPath),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), COMPILE_DB_STAT_TIMEOUT_MS))
      ])
      if (stat && stat.type === 'file') {
        return dir
      }
    } catch {
      // ENOENT or transport drop — try the next candidate.
    }
  }
  return null
}
