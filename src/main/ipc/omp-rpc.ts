// IPC surface for the session-less OMP RPC probe: a live slash-command catalog
// for the chat composer, and execution of allowlisted local commands (/usage).
// Every handler is fail-closed — it returns an error code rather than throwing
// across IPC, because the renderer's contract is "degrade to the static catalog
// and the PTY path", never "surface a crash".

import { ipcMain } from 'electron'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type {
  OmpRpcGetCommandsArgs,
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandArgs,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'
import type {
  OmpRpcBaseSpawnOptions,
  OmpRpcClientLike,
  OmpRpcSpawnOptions
} from '../../shared/omp-rpc-protocol'
import { createOmpRpcProbePool, type OmpRpcProbePool } from './omp-rpc-probe-pool'
import { isCommandOnLocalPath, resolveCommandOnLocalPath } from './command-path-resolver'
import { hydrateShellPathForAgentDetection } from './agent-detection-shell-path'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { createOmpExecutableResolver } from './omp-rpc-executable-resolver'
import { tokenizeCustomCommandTemplate } from '../../shared/commit-message-prompt'

let pool: OmpRpcProbePool | null = null
let isOmpRpcProbeShutdownInProgress = false

/** OMP resolves from PATH exactly as its TUI does; the resolver only widens the
 *  search (forced re-hydration, well-known installer paths) when the GUI PATH —
 *  or a cold-start hydration timeout cached process-wide — hides the binary. */
const resolveOmpExecutable = createOmpExecutableResolver({
  isCommandOnPath: isCommandOnLocalPath,
  resolveCommandOnPath: resolveCommandOnLocalPath,
  hydrateShellPath: () => hydrateShellPathForAgentDetection(),
  rehydrateShellPathForced: async () => {
    const hydration = await hydrateShellPath({ force: true })
    if (hydration.ok) {
      mergePathSegments(hydration.segments)
    }
  }
})

export async function resolveOmpRpcLaunch(
  agentCommand?: string | null
): Promise<Omit<OmpRpcBaseSpawnOptions, 'cwd'> | null> {
  const command = agentCommand?.trim() || TUI_AGENT_CONFIG.omp.launchCmd
  const parsed = tokenizeCustomCommandTemplate(
    command,
    process.platform === 'win32' ? 'literal' : 'escape'
  )
  const [executable, ...commandArgs] = parsed.ok ? parsed.tokens : []
  if (!executable) {
    return null
  }
  const executablePath = await resolveOmpExecutable(executable)
  if (!executablePath) {
    return null
  }
  return commandArgs.length > 0 ? { executablePath, commandArgs } : { executablePath }
}

async function spawnOmpRpcClientLazily(options: OmpRpcSpawnOptions): Promise<OmpRpcClientLike> {
  // Why: imported at call time so the concrete client (and the child-process
  // machinery it pulls in) never loads for users who don't run OMP.
  const { spawnOmpRpcClient } = await import('../omp-rpc/omp-rpc-client')
  return spawnOmpRpcClient(options)
}

function getPool(): OmpRpcProbePool | null {
  if (isOmpRpcProbeShutdownInProgress) {
    return null
  }
  pool ??= createOmpRpcProbePool({
    resolveExecutablePath: () => resolveOmpRpcLaunch(),
    // The pool owns lifecycle synchronously; the dynamic import is bridged by a
    // proxy client that defers each call to the resolved concrete client.
    spawn: (options) => createDeferredOmpRpcClient(spawnOmpRpcClientLazily(options))
  })
  return pool
}

export function registerOmpRpcHandlers(): void {
  ipcMain.handle(
    'ompRpc:getCommands',
    async (_event, args: OmpRpcGetCommandsArgs): Promise<OmpRpcGetCommandsResult> => {
      const cwd = args?.cwd?.trim()
      if (!cwd) {
        return { ok: false, errorCode: 'executable-not-found' }
      }
      try {
        const probePool = getPool()
        return probePool
          ? await probePool.getCommands(cwd)
          : { ok: false, errorCode: 'request-failed' }
      } catch {
        return { ok: false, errorCode: 'request-failed' }
      }
    }
  )
  ipcMain.handle(
    'ompRpc:runLocalCommand',
    async (_event, args: OmpRpcRunLocalCommandArgs): Promise<OmpRpcRunLocalCommandResult> => {
      const cwd = args?.cwd?.trim()
      if (!cwd) {
        return { ok: false, errorCode: 'executable-not-found' }
      }
      try {
        const probePool = getPool()
        return probePool
          ? await probePool.runLocalCommand(cwd, args?.command ?? '')
          : { ok: false, errorCode: 'request-failed' }
      } catch {
        return { ok: false, errorCode: 'request-failed' }
      }
    }
  )
}

/** App-quit teardown, joined into the will-quit barrier by
 *  src/main/startup/main-process-quit.ts (same shape as
 *  shutdownOmpRpcChatSessions): settles once every probe child has exited,
 *  or immediately when no pool was ever built. */
export function disposeOmpRpcProbes(): Promise<void> {
  isOmpRpcProbeShutdownInProgress = true
  const disposal = pool?.dispose() ?? Promise.resolve()
  pool = null
  return disposal
}

export function resetOmpRpcProbeShutdownForTests(): void {
  isOmpRpcProbeShutdownInProgress = false
}

type OmpRpcClientListener = Parameters<OmpRpcClientLike['on']>[0]

/** Adapts a not-yet-resolved client to the synchronous OmpRpcClientLike the pool
 *  holds. A listener registered during the spawn window attaches as soon as the
 *  child exists, so no `commands`/`exit` event is lost. */
function createDeferredOmpRpcClient(pending: Promise<OmpRpcClientLike>): OmpRpcClientLike {
  let disposed = false
  const resolved = pending.then((client) => {
    if (disposed) {
      client.dispose()
      throw new Error('OMP RPC probe disposed before it was ready')
    }
    return client
  })
  // Why: `resolved` is awaited lazily per call, so an early spawn failure would
  // otherwise surface as an unhandled rejection before the first call arrives.
  resolved.catch(() => {})
  return {
    whenReady: () => resolved.then((client) => client.whenReady()),
    getCommands: () => resolved.then((client) => client.getCommands()),
    prompt: (message, options) => resolved.then((client) => client.prompt(message, options)),
    steer: (message, images) => resolved.then((client) => client.steer(message, images)),
    followUp: (message, images) => resolved.then((client) => client.followUp(message, images)),
    // Why: the session-less probe never issues extension_ui_request, so a
    // deferred/not-yet-spawned client has nothing to answer synchronously.
    respondExtensionUi: () => false,
    on: (listener: OmpRpcClientListener) => {
      let detached = false
      let detach: (() => void) | null = null
      void resolved.then(
        (client) => {
          if (!detached) {
            detach = client.on(listener)
          }
        },
        () => {}
      )
      return () => {
        detached = true
        detach?.()
      }
    },
    dispose: () => {
      disposed = true
      void resolved.then(
        (client) => client.dispose(),
        () => {}
      )
    },
    // Why `pending`, not `resolved`: a client disposed during its spawn window
    // still has a child to wait for; only a spawn that never produced a child
    // has nothing to prove.
    whenExited: () =>
      pending.then(
        (client) => client.whenExited(),
        () => ({ code: null, signal: null })
      )
  }
}
