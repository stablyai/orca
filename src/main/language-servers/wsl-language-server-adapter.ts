// WSL host adapter (spec §4 + D5/D8, ticket 16): clangd runs inside the
// guest; the main process spawns it through `wsl.exe --exec` (shell-free, no
// capture fence) with the cached guest environment (PATH/HOME) prepended via
// the `env` binary. Binary discovery + version gate probe the guest PATH
// through one-shot shell-free commands. Path mapping translates Orca's Windows
// UNC identity <-> the guest POSIX form clangd answers in. The lifecycle
// machinery (didOpen warmup, 10min idle, LRU cap, version gate) applies
// identically because the session + host reach the host seam through this
// adapter.
import { toLinuxPath } from '../../shared/wsl-paths'
import { getWslGuestEnvironment, type WslGuestEnvironment } from '../wsl/wsl-guest-environment'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import {
  openNativeLanguageServerProcess,
  type NativeLanguageServerLaunch
} from './native-language-server-process'
import { wslNormalizeKey, wslPathToLspUri, wslLspUriToPath } from './wsl-path-mapping'
import {
  resolveWslClangdPath,
  resolveWslClangdVersionGate,
  buildWslClangdSpawnArgs,
  buildWslHostEnv
} from './wsl-clangd-resolution'
import { createWslCompileDbStrategy } from './compile-db/wsl-compile-db-strategy'
import {
  CLANGD_INSTALL_HINT,
  type ClangdLaunchOptions,
  type ClangdVersionGateResult
} from './clangd-launch'
import type { spawnProcess } from '../../shared/child-process/run-process'
import type {
  LanguageServerHostAdapter,
  LanguageServerProcessLaunch,
  LanguageServerProcessHandle,
  LanguageServerProcessHandlers
} from './language-server-host-adapter'
import type { CompileDbStrategy, CompileDbStrategyHooks } from './language-server-host-types'

const WSL_GUEST_ENV_PROBE_BUDGET_MS = 4_000

/**
 * Build the WSL host adapter bound to a distro. The distro is extracted from
 * the worktree's UNC path; the adapter memoizes the resolved clangd path +
 * guest environment per distro so the one-shot probes do not repeat across
 * sessions for the same distro.
 */
export function createWslHostAdapter(distro: string): LanguageServerHostAdapter {
  // Per-distro memo: the guest env probe + clangd path are distro-scoped.
  let cachedEnvironment: WslGuestEnvironment | null | undefined
  let cachedClangdPath: string | null | undefined

  async function ensureGuestEnvironment(): Promise<WslGuestEnvironment | null> {
    if (cachedEnvironment !== undefined) {
      return cachedEnvironment
    }
    cachedEnvironment = await getWslGuestEnvironment(distro, WSL_GUEST_ENV_PROBE_BUDGET_MS)
    return cachedEnvironment
  }

  async function ensureClangdPath(): Promise<string | null> {
    if (cachedClangdPath !== undefined) {
      return cachedClangdPath
    }
    const environment = await ensureGuestEnvironment()
    cachedClangdPath = await resolveWslClangdPath(distro, environment)
    return cachedClangdPath
  }

  function buildClangdArgs(opts?: ClangdLaunchOptions): string[] {
    const compileCommandsDir = opts?.compileCommandsDir ?? null
    const args: string[] = []
    if (compileCommandsDir) {
      // Translate the UNC/dir to guest form so clangd (in the guest) reads it.
      args.push(`--compile-commands-dir=${toLinuxPath(compileCommandsDir)}`)
    }
    args.push('--log=info')
    return args
  }

  return {
    kind: 'wsl',
    normalizeKey: wslNormalizeKey,
    pathToLspUri: wslPathToLspUri,
    lspUriToPath: (uri: string): string => wslLspUriToPath(uri, distro),
    resolveClangdProgram: (): string => resolveWslExecutablePath(),
    async resolveClangdVersionGate(_program: string): Promise<ClangdVersionGateResult> {
      // The guest env + clangd path are needed for the version probe; the
      // `_program` arg is the wsl.exe path (ignored — clangd is in the guest).
      const environment = await ensureGuestEnvironment()
      const clangdPath = await ensureClangdPath()
      if (!clangdPath) {
        return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
      }
      return resolveWslClangdVersionGate(distro, environment, clangdPath)
    },
    async buildLaunch(
      _worktreeRoot: string,
      opts?: ClangdLaunchOptions
    ): Promise<LanguageServerProcessLaunch> {
      const environment = await ensureGuestEnvironment()
      const clangdPath = await ensureClangdPath()
      if (!clangdPath) {
        throw new Error('clangd was not found in the WSL guest PATH.')
      }
      const clangdArgs = buildClangdArgs(opts)
      return {
        program: resolveWslExecutablePath(),
        // wsl.exe --exec + env prefix (PATH/HOME) + clangd: shell-free, no fence (spec D8).
        args: buildWslClangdSpawnArgs(distro, environment, clangdPath, clangdArgs),
        cwd: resolveWslInteropSpawnCwd() ?? process.cwd(),
        env: buildWslHostEnv()
      }
    },
    openProcess(
      launch: LanguageServerProcessLaunch,
      handlers: LanguageServerProcessHandlers,
      spawnImpl?: typeof spawnProcess
    ): LanguageServerProcessHandle {
      // The process handle logic (stderr line-buffer, exit ladder, tree kill)
      // is shared with native — only the launch spec (wsl.exe argv + WSL_UTF8
      // env) differs, and that is already baked into `launch`.
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
      return createWslCompileDbStrategy(worktreeRoot, hooks)
    }
  }
}
