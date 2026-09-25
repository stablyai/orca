// WSL compile-db strategy (spec D9 + §6): detection-only. clangd runs inside
// the guest, so a pre-existing `compile_commands.json` is detected through the
// Windows UNC view of the distro (`\\wsl.localhost\<distro>\…`, which Windows
// can read) and pointed at explicitly via `--compile-commands-dir` in GUEST
// path form. CMake generation inside the guest is out of scope for ticket 16
// (the host adapter's job is spawn + path mapping + lifecycle + version gate);
// when no db exists, clangd degrades to single-file navigation (spec §6) —
// which still yields hover/definition/references within the active file.
import { detectExistingCompileCommandsDir } from '../clangd-launch'
import { toLinuxPath } from '../../../shared/wsl-paths'
import {
  COMPILE_DB_DEGRADED_HINT,
  type CompileDbResolution,
  type CompileDbStrategy,
  type CompileDbStrategyHooks
} from './compile-db-strategy-types'

/**
 * Detection-only compile-db strategy for a WSL worktree. Reuses S1's
 * `detectExistingCompileCommandsDir` (UNC paths are readable from Windows);
 * the resolved dir is translated to its guest form when handed to clangd.
 */
export function createWslCompileDbStrategy(
  worktreeRoot: string,
  hooks: CompileDbStrategyHooks
): CompileDbStrategy {
  return {
    async resolve(): Promise<CompileDbResolution> {
      const existing = detectExistingCompileCommandsDir(worktreeRoot)
      if (existing) {
        hooks.onDegraded?.(null)
        return { compileCommandsDir: toLinuxPath(existing), degraded: false }
      }
      // No guest-cmake lane yet (ticket 16 scope): single-file navigation.
      hooks.onDegraded?.(COMPILE_DB_DEGRADED_HINT)
      return { compileCommandsDir: null, degraded: true }
    },
    dispose(): void {
      // No watcher — detection is a single stat pass.
    }
  }
}
