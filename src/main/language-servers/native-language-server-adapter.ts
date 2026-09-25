// Native (Windows/macOS/Linux local) host adapter (spec §4 + D5/D8). Wraps
// the existing S1/S2 functions — PATH discovery, native `file:` URI mapping,
// `spawnProcess` launch — behind the host-adapter interface so WSL is a second
// implementation. The session and host reach these through the adapter, never
// the bare functions, so the per-host seam stays in one place.
import { resolveClangdProgram, resolveClangdVersionGate, buildClangdLaunch } from './clangd-launch'
import { nativePathToLspUri, lspUriToNativePath, normalizeNativeFilePath } from './uri-mapping'
import {
  openNativeLanguageServerProcess,
  type NativeLanguageServerLaunch
} from './native-language-server-process'
import { createCompileDbStrategy } from './compile-db/compile-db-strategy-orchestrator'
import { runProcess } from '../../shared/child-process/run-process'
import type { spawnProcess } from '../../shared/child-process/run-process'
import type {
  LanguageServerHostAdapter,
  LanguageServerProcessLaunch,
  LanguageServerProcessHandle,
  LanguageServerProcessHandlers
} from './language-server-host-adapter'
import type { ClangdLaunchOptions } from './clangd-launch'
import type { CompileDbStrategy, CompileDbStrategyHooks } from './language-server-host-types'

/** The native host: clangd on the local PATH, `file:` URIs from local paths. */
export function createNativeHostAdapter(): LanguageServerHostAdapter {
  return {
    kind: 'native',
    normalizeKey: normalizeNativeFilePath,
    pathToLspUri: nativePathToLspUri,
    lspUriToPath: lspUriToNativePath,
    resolveClangdProgram: () => resolveClangdProgram(),
    resolveClangdVersionGate: (program) => resolveClangdVersionGate(program),
    async buildLaunch(
      worktreeRoot: string,
      opts?: ClangdLaunchOptions
    ): Promise<LanguageServerProcessLaunch> {
      const plan = buildClangdLaunch(worktreeRoot, opts ?? {})
      // Native: the process cwd is the worktree root; env inherits process.env.
      return { program: plan.program, args: plan.args, cwd: worktreeRoot }
    },
    openProcess(
      launch: LanguageServerProcessLaunch,
      handlers: LanguageServerProcessHandlers,
      spawnImpl?: typeof spawnProcess
    ): LanguageServerProcessHandle {
      return openNativeLanguageServerProcess(
        {
          program: launch.program,
          args: launch.args,
          cwd: launch.cwd,
          env: launch.env
        } satisfies NativeLanguageServerLaunch,
        handlers,
        spawnImpl
      )
    },
    createDbStrategy(worktreeRoot: string, hooks: CompileDbStrategyHooks): CompileDbStrategy {
      return createCompileDbStrategy(worktreeRoot, hooks, runProcess)
    }
  }
}
