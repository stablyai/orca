/* oxlint-disable max-lines */
import type { IPty } from 'node-pty'
import type * as NodePty from 'node-pty'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  resolveDefaultShell,
  resolveProcessCwd,
  processHasChildren,
  getForegroundProcessName,
  listShellProfiles
} from './pty-shell-utils'

// Why: node-pty is a native addon that may not be installed on the remote.
// Dynamic import keeps the require() lazy so loadPty() returns null gracefully
// when the native module is unavailable. The static type import lets vitest
// intercept it in tests.
let ptyModule: typeof NodePty | null = null
async function loadPty(): Promise<typeof NodePty | null> {
  if (ptyModule) {
    return ptyModule
  }
  try {
    ptyModule = await import('node-pty')
    return ptyModule
  } catch {
    return null
  }
}

type ManagedPty = {
  id: string
  pty: IPty
  initialCwd: string
  buffered: string
  /** Timer for SIGKILL fallback after a graceful SIGTERM shutdown. */
  killTimer?: ReturnType<typeof setTimeout>
}
const DEFAULT_GRACE_TIME_MS = 5 * 60 * 1000
export const REPLAY_BUFFER_MAX = 100 * 1024
const ALLOWED_SIGNALS = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGKILL',
  'SIGTSTP',
  'SIGCONT',
  'SIGWINCH',
  'SIGUSR1',
  'SIGUSR2'
])

type SerializedPtyEntry = { id: string; pid: number; cols: number; rows: number; cwd: string }

export class PtyHandler {
  private ptys = new Map<string, ManagedPty>()
  private nextId = 1
  private dispatcher: RelayDispatcher
  private graceTimeMs: number
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(dispatcher: RelayDispatcher, graceTimeMs = DEFAULT_GRACE_TIME_MS) {
    this.dispatcher = dispatcher
    this.graceTimeMs = graceTimeMs
    this.registerHandlers()
  }

  /** Wire onData/onExit listeners for a managed PTY and store it. */
  private wireAndStore(managed: ManagedPty): void {
    this.ptys.set(managed.id, managed)
    managed.pty.onData((data: string) => {
      managed.buffered += data
      if (managed.buffered.length > REPLAY_BUFFER_MAX) {
        managed.buffered = managed.buffered.slice(-REPLAY_BUFFER_MAX)
      }
      this.dispatcher.notify('pty.data', { id: managed.id, data })
    })
    managed.pty.onExit(({ exitCode }: { exitCode: number }) => {
      // Why: If the PTY exits normally (or via SIGTERM), we must clear the
      // SIGKILL fallback timer to avoid sending SIGKILL to a recycled PID.
      if (managed.killTimer) {
        clearTimeout(managed.killTimer)
        managed.killTimer = undefined
      }
      this.dispatcher.notify('pty.exit', { id: managed.id, code: exitCode })
      this.ptys.delete(managed.id)
    })
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('pty.spawn', (p, context) => this.spawn(p, context))
    this.dispatcher.onRequest('pty.attach', (p) => this.attach(p))
    this.dispatcher.onRequest('pty.shutdown', (p) => this.shutdown(p))
    this.dispatcher.onRequest('pty.sendSignal', (p) => this.sendSignal(p))
    this.dispatcher.onRequest('pty.getCwd', (p) => this.getCwd(p))
    this.dispatcher.onRequest('pty.getInitialCwd', (p) => this.getInitialCwd(p))
    this.dispatcher.onRequest('pty.clearBuffer', (p) => this.clearBuffer(p))
    this.dispatcher.onRequest('pty.hasChildProcesses', (p) => this.hasChildProcesses(p))
    this.dispatcher.onRequest('pty.getForegroundProcess', (p) => this.getForegroundProcess(p))
    this.dispatcher.onRequest('pty.listProcesses', () => this.listProcesses())
    this.dispatcher.onRequest('pty.getDefaultShell', async () => resolveDefaultShell())
    this.dispatcher.onRequest('pty.serialize', (p) => this.serialize(p))
    this.dispatcher.onRequest('pty.revive', (p) => this.revive(p))
    this.dispatcher.onRequest('pty.getProfiles', async () => listShellProfiles())

    this.dispatcher.onNotification('pty.data', (p) => this.writeData(p))
    this.dispatcher.onNotification('pty.resize', (p) => this.resize(p))
    this.dispatcher.onNotification('pty.ackData', (_p) => {
      /* flow control ack -- not yet enforced */
    })
  }

  private async spawn(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<{ id: string }> {
    if (this.ptys.size >= 50) {
      throw new Error('Maximum number of PTY sessions reached (50)')
    }
    const pty = await loadPty()
    if (!pty) {
      throw new Error('node-pty is not available on this remote host')
    }

    const cols = (params.cols as number) || 80
    const rows = (params.rows as number) || 24
    const cwd = (params.cwd as string) || process.env.HOME || '/'
    const env = params.env as Record<string, string> | undefined
    const shell = resolveDefaultShell()
    const id = `pty-${this.nextId++}`

    // Why: SSH exec channels give the relay a minimal environment without
    // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
    // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
    const term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...env } as Record<string, string>
    })

    const managed: ManagedPty = { id, pty: term, initialCwd: cwd, buffered: '' }
    this.wireAndStore(managed)
    if (context?.isStale()) {
      // Why: if the client reconnected while pty.spawn was in flight, the
      // response is discarded and no renderer can own this PTY. Shut it down
      // immediately so it does not linger as an unreachable remote shell.
      term.kill('SIGTERM')
      managed.killTimer = setTimeout(() => {
        if (this.ptys.has(id)) {
          term.kill('SIGKILL')
        }
      }, 5000)
    }
    return { id }
  }

  private async attach(params: Record<string, unknown>): Promise<{ replay?: string }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed) {
      throw new Error(`PTY "${id}" not found`)
    }

    // Replay buffered output. During pty.spawn({ sessionId }) the renderer has
    // not registered replay handlers yet, so return the bytes to the caller
    // instead of notifying them too early.
    // Why: the buffer is NOT cleared after replay. It always holds the last
    // 100 KB of raw output (capped in onData). The client clears xterm before
    // writing the replay, so returning the full buffer on every attach does
    // not cause duplication. Keeping the buffer intact means a second app
    // restart still replays the full terminal history instead of only output
    // generated since the previous attach.
    if (managed.buffered) {
      if (params.suppressReplayNotification) {
        return { replay: managed.buffered }
      }
      this.dispatcher.notify('pty.replay', { id, data: managed.buffered })
    }
    return {}
  }

  private writeData(params: Record<string, unknown>): void {
    const id = params.id as string
    const data = params.data as string
    if (typeof data !== 'string') {
      return
    }
    const managed = this.ptys.get(id)
    if (managed) {
      managed.pty.write(data)
    }
  }

  private resize(params: Record<string, unknown>): void {
    const id = params.id as string
    const cols = Math.max(1, Math.min(500, Math.floor(Number(params.cols) || 80)))
    const rows = Math.max(1, Math.min(500, Math.floor(Number(params.rows) || 24)))
    const managed = this.ptys.get(id)
    if (managed) {
      managed.pty.resize(cols, rows)
    }
  }

  private async shutdown(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const immediate = params.immediate as boolean
    const managed = this.ptys.get(id)
    if (!managed) {
      return
    }

    if (immediate) {
      managed.pty.kill('SIGKILL')
    } else {
      managed.pty.kill('SIGTERM')

      // Why: Some processes ignore SIGTERM (e.g. a hung child, a custom signal
      // handler). Without a SIGKILL fallback the PTY process would leak and the
      // managed entry would never be cleaned up. The 5-second window gives
      // well-behaved processes time to flush and exit gracefully. The timer is
      // cleared in the onExit handler if the process terminates on its own.
      managed.killTimer = setTimeout(() => {
        if (this.ptys.has(id)) {
          managed.pty.kill('SIGKILL')
        }
      }, 5000)
    }
  }

  private async sendSignal(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const signal = params.signal as string
    if (!ALLOWED_SIGNALS.has(signal)) {
      throw new Error(`Signal not allowed: ${signal}`)
    }
    const managed = this.ptys.get(id)
    if (!managed) {
      throw new Error(`PTY "${id}" not found`)
    }
    managed.pty.kill(signal)
  }

  private async getCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return resolveProcessCwd(managed.pty.pid, managed.initialCwd)
  }

  private async getInitialCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return managed.initialCwd
  }

  private async clearBuffer(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (managed) {
      managed.pty.clear()
    }
  }

  private async hasChildProcesses(params: Record<string, unknown>): Promise<boolean> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed) {
      return false
    }
    return await processHasChildren(managed.pty.pid)
  }

  private async getForegroundProcess(params: Record<string, unknown>): Promise<string | null> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed) {
      return null
    }
    return await getForegroundProcessName(managed.pty.pid)
  }

  private async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    const results: { id: string; cwd: string; title: string }[] = []
    for (const [id, managed] of this.ptys) {
      const title = (await getForegroundProcessName(managed.pty.pid)) || 'shell'
      results.push({ id, cwd: managed.initialCwd, title })
    }
    return results
  }

  private async serialize(params: Record<string, unknown>): Promise<string> {
    const ids = params.ids as string[]
    const entries: SerializedPtyEntry[] = []
    for (const id of ids) {
      const managed = this.ptys.get(id)
      if (!managed) {
        continue
      }
      const { pid, cols, rows } = managed.pty
      entries.push({ id, pid, cols, rows, cwd: managed.initialCwd })
    }
    return JSON.stringify(entries)
  }

  private async revive(params: Record<string, unknown>): Promise<void> {
    const state = params.state as string
    const entries = JSON.parse(state) as SerializedPtyEntry[]

    for (const entry of entries) {
      if (this.ptys.has(entry.id)) {
        continue
      }
      // Only re-attach if the original process is still alive
      try {
        process.kill(entry.pid, 0)
      } catch {
        continue
      }
      const ptyMod = await loadPty()
      if (!ptyMod) {
        continue
      }
      const term = ptyMod.spawn(resolveDefaultShell(), ['-l'], {
        name: 'xterm-256color',
        cols: entry.cols,
        rows: entry.rows,
        cwd: entry.cwd,
        env: process.env as Record<string, string>
      })
      this.wireAndStore({ id: entry.id, pty: term, initialCwd: entry.cwd, buffered: '' })

      // Why: nextId starts at 1 and is only incremented by spawn(). Revived
      // PTYs carry their original IDs (e.g. "pty-3"), so without this bump the
      // next spawn() would generate an ID that collides with an already-active
      // revived PTY.
      const match = entry.id.match(/^pty-(\d+)$/)
      if (match) {
        const revivedNum = parseInt(match[1], 10)
        if (revivedNum >= this.nextId) {
          this.nextId = revivedNum + 1
        }
      }
    }
  }

  startGraceTimer(onExpire: () => void): void {
    this.cancelGraceTimer()
    // Why: always wait the full grace period even with zero PTYs.  A detached
    // relay may have no PTYs yet but a --connect client will arrive shortly.
    // Firing immediately would kill the relay before anyone could connect.
    this.graceTimer = setTimeout(() => {
      onExpire()
    }, this.graceTimeMs)
  }

  cancelGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  dispose(): void {
    this.cancelGraceTimer()
    for (const [, managed] of this.ptys) {
      if (managed.killTimer) {
        clearTimeout(managed.killTimer)
      }
      managed.pty.kill('SIGTERM')
    }
    this.ptys.clear()
  }

  get activePtyCount(): number {
    return this.ptys.size
  }
}
