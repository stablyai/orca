/**
 * Utility-process launcher shim for the detached terminal daemon.
 *
 * Why this hop exists: the Electron main process carries Chromium-owned
 * descriptors that are not close-on-exec (POSIX) / not inheritance-protected
 * (Windows) — the DevTools CDP listener, the crashpad client channel, mojo
 * socketpairs, and writable profile file descriptors among them. A daemon
 * forked directly from main inherits all of them on Linux and Windows, passes
 * them to every PTY child, and — because the daemon outlives the app — keeps
 * dead-instance resources alive: the CDP port stays bound with no acceptor, so
 * a relaunched app comes back debugger-less. A utility process is launched by
 * Chromium's own process launcher, which grants children an explicit
 * stdio/ipc-only descriptor set, so a daemon forked from HERE starts clean.
 *
 * Runs inside `utilityProcess.fork` with no window and no electron imports;
 * talks to the main process only through `process.parentPort`.
 */
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import type {
  DaemonShimDownMessage,
  DaemonShimUpMessage,
  UtilityDaemonForkSpec
} from './daemon-utility-fork-messages'

export type ShimParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
  start?: () => void
}

type ShimSpawn = (spec: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  detached: boolean
  stdio: ('ignore' | 'pipe' | 'ipc')[]
}) => SpawnedProcess

/** Delay before self-exit after relaying the daemon's exit, so the message wins the race. */
const EXIT_RELAY_LINGER_MS = 2000

export function runDaemonUtilityLauncherShim(
  port: ShimParentPort,
  spawn: ShimSpawn = spawnProcess,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  let child: SpawnedProcess | null = null
  let launched = false
  let released = false

  const post = (message: DaemonShimUpMessage): void => port.postMessage(message)

  const release = (): void => {
    if (released) {
      return
    }
    released = true
    if (child) {
      // Mirror of the direct-fork launcher: drop IPC and stderr so the daemon
      // runs detached, then leave; the daemon must not die with this shim.
      if (child.connected) {
        child.disconnect()
      }
      child.stderr?.destroy()
      child.unref()
    }
    exit(0)
  }

  const launch = (spec: UtilityDaemonForkSpec): void => {
    try {
      child = spawn({
        program: spec.execPath,
        args: [spec.entryPath, ...spec.args],
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
    } catch (error) {
      post({ kind: 'spawn-error', message: error instanceof Error ? error.message : String(error) })
      exit(1)
      return
    }
    child.on('message', (message) => post({ kind: 'daemon-message', message }))
    child.stderr?.on('data', (chunk: Buffer | string) =>
      post({ kind: 'daemon-stderr', text: chunk.toString('utf8') })
    )
    child.on('error', (error) => post({ kind: 'daemon-error', message: error.message }))
    child.on('exit', (code, signal) => {
      post({ kind: 'daemon-exit', code, signal })
      // The parent kills this shim on receipt; the linger only covers a parent
      // that is already gone.
      setTimeout(() => exit(0), EXIT_RELAY_LINGER_MS)
    })
    if (typeof child.pid === 'number') {
      post({ kind: 'spawned', pid: child.pid })
    } else {
      post({ kind: 'spawn-error', message: 'daemon child has no pid' })
      // A pid-less child may still be a live process the parent can never
      // address (it never learns a pid to kill); don't leave an orphan behind.
      try {
        child.kill()
      } catch {
        // already gone
      }
      exit(1)
    }
  }

  port.on('message', (event) => {
    const message = event.data as DaemonShimDownMessage | null
    if (!message || typeof message !== 'object') {
      return
    }
    if (message.kind === 'spawn' && !launched) {
      launched = true
      launch(message.spec)
    } else if (message.kind === 'release') {
      release()
    }
  })
  port.start?.()
  post({ kind: 'shim-ready' })
}

const parentPort = (process as unknown as { parentPort?: ShimParentPort }).parentPort
if (parentPort) {
  runDaemonUtilityLauncherShim(parentPort)
}
