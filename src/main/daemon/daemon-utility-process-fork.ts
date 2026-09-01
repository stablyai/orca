/**
 * Forks the detached terminal daemon through an Electron utility process on
 * Linux and Windows so it starts with a clean descriptor/handle table.
 *
 * Why: Chromium descriptors in the Electron main process (the CDP listener,
 * crashpad channel, mojo socketpairs, writable profile files) are inheritable
 * on Linux and Windows, and a daemon forked directly from main carries them —
 * and hands them to every PTY child — for its whole detached lifetime. The
 * observable damage: after the app exits or restarts, the daemon lineage keeps
 * the CDP port bound with no acceptor (the relaunched app comes back
 * debugger-less), keeps a dead instance's crashpad handler alive, and pins
 * deleted shared-memory segments. Chromium launches utility processes with an
 * explicit stdio-only descriptor grant on both platforms, so a daemon forked
 * from a utility-process shim inherits none of that.
 *
 * macOS keeps the direct fork: libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT
 * there (children already start clean), and macOS TCC attribution relies on
 * the direct app→daemon fork chain (STA-3491).
 */
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  DaemonShimDownMessage,
  DaemonShimUpMessage,
  UtilityDaemonForkSpec
} from './daemon-utility-fork-messages'

/**
 * The structural slice of ChildProcess the daemon launcher consumes. The
 * direct-fork path returns a real ChildProcess, which satisfies this.
 */
export type LaunchedDaemonChild = {
  pid?: number | undefined
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  connected: boolean
  stderr: LaunchedDaemonStderr | null
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  // Why any[] not never[]: mirrors EventEmitter.off, which class implements-checks compare non-bivariantly.
  off(event: string, listener: (...args: any[]) => void): unknown
  disconnect(): void
  unref(): void
}

export type LaunchedDaemonStderr = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  off(event: 'data', listener: (chunk: Buffer) => void): unknown
  destroy(): void
}

/** The slice of Electron's UtilityProcess this module drives. */
export type UtilityProcessLike = {
  pid?: number
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  // Electron's experimental V8 fatal-error event; unlistened, its EventEmitter
  // 'error' emission is an uncaught exception in the main process.
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
  kill(): boolean
}

export type UtilityProcessForkFn = (
  modulePath: string,
  args?: string[],
  options?: { stdio?: string; serviceName?: string }
) => UtilityProcessLike

/** How long the shim gets to spawn and report the daemon pid. */
const SHIM_HANDSHAKE_TIMEOUT_MS = 10_000
/** After release, how long the shim gets to exit on its own before a kill. */
const SHIM_RELEASE_KILL_DELAY_MS = 5_000

// Why a host port and not an electron import: this module sits in the daemon
// launcher's graph, which the Orca runtime must be able to load on plain Node
// (`orca serve`). The desktop installs the real utilityProcess.fork from
// src/main/host/ at bootstrap; a Node host installs nothing — its parent
// process has no Chromium descriptors, so the direct fork is already clean.
let installedUtilityProcessFork: UtilityProcessForkFn | null = null

export function setDaemonUtilityProcessFork(fork: UtilityProcessForkFn | null): void {
  installedUtilityProcessFork = fork
}

export function canForkDaemonThroughUtilityProcess(
  platform: NodeJS.Platform = process.platform,
  versions: { electron?: string } = process.versions
): boolean {
  if (platform === 'darwin') {
    return false
  }
  if (installedUtilityProcessFork !== null) {
    return true
  }
  // An Electron host with no installed port means the bootstrap install line was
  // dropped — a silent revert of every Linux/Windows launch to the leaky direct
  // fork. Plain-node hosts (orca serve) legitimately install nothing: their
  // parent has no Chromium descriptors, so stay quiet there.
  if (versions.electron) {
    console.warn(
      '[daemon] No utility-process fork installed on this Electron host; the daemon will inherit Chromium descriptors (was the bootstrap wiring dropped?)'
    )
  }
  return false
}

function getDaemonUtilityLauncherShimPath(): string {
  // Why not the app.asar.unpacked redirect daemon-entry needs: the shim runs
  // under the Electron runtime, which reads asar directly.
  const appPath = getAppEnvironment().getAppPath()
  const directPath = join(appPath, 'daemon-utility-launcher-shim.js')
  return existsSync(directPath)
    ? directPath
    : join(appPath, 'out', 'main', 'daemon-utility-launcher-shim.js')
}

class UtilityForkedDaemonStderr extends EventEmitter implements LaunchedDaemonStderr {
  destroy(): void {
    this.removeAllListeners()
  }
}

class UtilityForkedDaemonChild extends EventEmitter implements LaunchedDaemonChild {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  connected = true
  readonly stderr = new UtilityForkedDaemonStderr()

  private daemonExited = false
  private releasedShim = false
  private shimFatalError: Error | null = null

  constructor(private readonly shim: UtilityProcessLike) {
    super()
  }

  // A launch abandoned mid-handshake (or a shim crash after startup listeners
  // detach) can still relay errors into a child nobody holds, and an unlistened
  // EventEmitter 'error' throws — in main that is an uncaught exception, the
  // exact failure mode this launcher exists to prevent. Degrade to a warn.
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.listenerCount('error') === 0) {
      console.warn('[daemon] Utility-forked daemon launch error with no listener:', args[0])
      return false
    }
    return super.emit(event, ...args)
  }

  /** A fatal shim error is always followed by shim exit; keep the cause for it. */
  noteShimFatalError(error: Error): void {
    this.shimFatalError = error
  }

  handleShimMessage(message: DaemonShimUpMessage): void {
    switch (message.kind) {
      case 'daemon-message':
        this.emit('message', message.message)
        break
      case 'daemon-stderr':
        this.stderr.emit('data', Buffer.from(message.text, 'utf8'))
        break
      case 'daemon-error':
        // After release the launcher has dropped its listeners; an unlistened
        // 'error' emission is an uncaught exception in the main process.
        if (!this.releasedShim) {
          this.emit('error', new Error(message.message))
        }
        break
      case 'daemon-exit':
        this.daemonExited = true
        this.exitCode = message.code
        this.signalCode = message.signal
        this.emit('exit', message.code, message.signal)
        // The shim has nothing left to relay.
        this.shim.kill()
        break
      case 'shim-ready':
      case 'spawned':
      case 'spawn-error':
        // Handshake messages; the launch promise consumes them before routing here.
        break
    }
  }

  handleShimExit(): void {
    if (this.daemonExited || this.releasedShim) {
      return
    }
    // The relay died while the launch still depended on it. The daemon may be
    // fine, but readiness/exit can no longer be observed — surface it like a
    // fork error so the launcher's failure path owns cleanup by pid.
    this.emit(
      'error',
      new Error(
        `Daemon utility launcher exited before the daemon settled${
          this.shimFatalError ? `: ${this.shimFatalError.message}` : ''
        }`
      )
    )
  }

  disconnect(): void {
    if (!this.connected) {
      return
    }
    this.connected = false
    this.releasedShim = true
    const down: DaemonShimDownMessage = { kind: 'release' }
    try {
      this.shim.postMessage(down)
    } catch {
      // Shim already gone; the daemon is detached either way.
    }
    // Fallback if the shim ignores the release; timer must not hold the loop.
    const killTimer = setTimeout(() => this.shim.kill(), SHIM_RELEASE_KILL_DELAY_MS)
    killTimer.unref?.()
    this.shim.on('exit', () => clearTimeout(killTimer))
  }

  unref(): void {
    // The shim exits right after release and the daemon is already detached;
    // there is no parent-side handle left to unref.
  }
}

export async function forkDaemonThroughUtilityProcess(
  spec: UtilityDaemonForkSpec,
  forkUtilityProcess?: UtilityProcessForkFn
): Promise<LaunchedDaemonChild> {
  const fork = forkUtilityProcess ?? installedUtilityProcessFork
  if (!fork) {
    throw new Error('No utility-process fork is installed on this host')
  }
  const shim = fork(getDaemonUtilityLauncherShimPath(), [], {
    stdio: 'ignore',
    serviceName: 'orca-daemon-launcher'
  })
  const child = new UtilityForkedDaemonChild(shim)

  return await new Promise<LaunchedDaemonChild>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      fail(new Error('Daemon utility launcher handshake timed out'))
    }, SHIM_HANDSHAKE_TIMEOUT_MS)

    function fail(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      shim.kill()
      reject(error)
    }

    shim.on('error', (type, location) => {
      const error = new Error(`Daemon utility launcher hit a fatal error: ${type} at ${location}`)
      if (!settled) {
        fail(error)
        return
      }
      // Electron always follows 'error' with 'exit'; the exit path surfaces it.
      child.noteShimFatalError(error)
    })
    shim.on('message', (raw) => {
      const message = raw as DaemonShimUpMessage | null
      if (!message || typeof message !== 'object') {
        return
      }
      if (message.kind === 'shim-ready') {
        const down: DaemonShimDownMessage = { kind: 'spawn', spec }
        shim.postMessage(down)
        return
      }
      if (message.kind === 'spawned') {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.pid = message.pid
          resolve(child)
        }
        return
      }
      if (message.kind === 'spawn-error') {
        fail(new Error(`Daemon spawn failed in utility launcher: ${message.message}`))
        return
      }
      child.handleShimMessage(message)
    })
    shim.on('exit', () => {
      if (!settled) {
        fail(new Error('Daemon utility launcher exited during the launch handshake'))
        return
      }
      child.handleShimExit()
    })
  })
}
