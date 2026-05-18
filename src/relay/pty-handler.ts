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
import { getRelayShellLaunchConfig } from './pty-shell-launch'

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
  /** True once disposeManagedPty has run. Prevents double-dispose (onExit + an
   *  explicit shutdown can both fire for the same PTY) and converts post-dispose
   *  entry-point calls into a clean "not found" error instead of a silent no-op
   *  (POSIX proc.kill is neutralized inside disposeManagedPty). */
  disposed?: boolean
  /** True once external cleanup observers have been notified. Forced cleanup
   *  paths can run before node-pty emits onExit; this prevents duplicate
   *  overlay/cache cleanup if onExit arrives later. */
  exitListenerNotified?: boolean
  /** Renderer-supplied paneKey from spawn env (ORCA_PANE_KEY). Captured so
   *  external observers (the relay-hook-server cache) can evict per-pane
   *  state when this PTY exits. Symmetric with Orca's local pty.ts. */
  paneKey?: string
  tabId?: string
  worktreeId?: string
}

function disposeManagedPty(managed: ManagedPty): void {
  if (managed.disposed) {
    return
  }
  managed.disposed = true
  // Why: clear any pending 5s SIGKILL fallback timer. If graceful-shutdown
  // armed a killTimer and the child then exited cleanly (firing onExit →
  // disposeManagedPty), the timer would otherwise fire later and attempt
  // pty.kill('SIGKILL') on an already-disposed instance. The ptys.has(id)
  // guard inside the timer short-circuits today, but symmetry is clearer.
  if (managed.killTimer) {
    clearTimeout(managed.killTimer)
    managed.killTimer = undefined
  }
  // Why: UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`.
  // The close event fires asynchronously; by then the child may have exited and
  // its pid been recycled. On the Linux remote hosts the relay typically runs on,
  // pid recycling is fast — SIGHUP to a stranger is a real hazard. Neutralize
  // managed.pty.kill before destroy() runs. Windows exempt: WindowsTerminal.destroy
  // IS a kill() call via _deferNoArgs — neutralizing it leaks the ConPTY agent.
  if (process.platform !== 'win32') {
    ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(managed.pty as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow */
  }
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

type SerializedPtyEntry = {
  id: string
  pid: number
  cols: number
  rows: number
  cwd: string
  paneKey?: string
  tabId?: string
  worktreeId?: string
}

export type PtyExitListener = (event: { id: string; paneKey?: string }) => void
/** Returns env to merge into the PTY's spawn env. Receives spawn context so
 *  augmenters that need a per-PTY identity (e.g. OPENCODE_CONFIG_DIR overlay
 *  paths derived from the renderer's paneKey) can compute it without pulling
 *  the renderer's env in twice. */
export type PtyEnvAugmenter = (ctx: {
  id: string
  paneKey?: string
  shell: string
  env: Record<string, string>
}) => Record<string, string>

export class PtyHandler {
  private ptys = new Map<string, ManagedPty>()
  private nextId = 1
  private dispatcher: RelayDispatcher
  private graceTimeMs: number
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  // Why: external observers need to drop per-pane state when a PTY exits.
  // Today the relay composes multiple consumers (hook-server cache eviction
  // and plugin-overlay dir cleanup) into a single callback at the call site
  // (see relay.ts setExitListener). A single optional slot is intentional —
  // callers compose externally rather than us maintaining a listener list.
  // A throw inside the listener is swallowed so it can never block
  // disposeManagedPty / map cleanup.
  private exitListener: PtyExitListener | null = null
  // Why: env augmenters injected at relay boot (currently the relay-hook
  // server's ORCA_AGENT_HOOK_* coords). Run on every spawn so every PTY
  // sees the live hook coordinates without the dispatcher needing to know
  // about agent hooks.
  private envAugmenters: PtyEnvAugmenter[] = []

  constructor(dispatcher: RelayDispatcher, graceTimeMs = DEFAULT_GRACE_TIME_MS) {
    this.dispatcher = dispatcher
    this.graceTimeMs = graceTimeMs
    this.registerHandlers()
  }

  /** Subscribe to PTY-exit events. Used by the relay-hook server to evict
   *  per-paneKey cached payloads when the backing PTY ends. */
  setExitListener(listener: PtyExitListener | null): void {
    this.exitListener = listener
  }

  /** Register an env augmenter whose return value is merged into every spawn
   *  env *after* `process.env` and the renderer-supplied env. Used by the
   *  relay-hook server to inject ORCA_AGENT_HOOK_PORT/TOKEN/ENV/VERSION/
   *  ENDPOINT — values the agent CLI inside the PTY needs to find the local
   *  hook receiver. See docs/design/agent-status-over-ssh.md §3. */
  addEnvAugmenter(augmenter: PtyEnvAugmenter): () => void {
    this.envAugmenters.push(augmenter)
    return () => {
      const idx = this.envAugmenters.indexOf(augmenter)
      if (idx !== -1) {
        this.envAugmenters.splice(idx, 1)
      }
    }
  }

  /** Build the augmented spawn env. Augmenter values override `process.env`
   *  and any renderer-supplied env (the augmenter contract — see
   *  addEnvAugmenter doc-comment). Used by both spawn() and revive() so the
   *  relationship between process.env, renderer env, and augmenters cannot
   *  drift between the two paths — revived shells after a relay restart must
   *  see the fresh ORCA_AGENT_HOOK_* coords just like freshly-spawned ones,
   *  otherwise agent-status over SSH silently breaks on every revive. */
  private buildSpawnEnv(
    rendererEnv: Record<string, string> | undefined,
    ctx: { id: string; paneKey?: string; shell: string }
  ): Record<string, string> {
    const baseEnv = { ...process.env, ...rendererEnv } as Record<string, string>
    const augmented: Record<string, string> = {}
    for (const augmenter of this.envAugmenters) {
      try {
        Object.assign(augmented, augmenter({ ...ctx, env: baseEnv }))
      } catch (err) {
        process.stderr.write(
          `[pty-handler] env augmenter threw: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
    return { ...baseEnv, ...augmented }
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
      if (managed.disposed) {
        return
      }
      // Why: neutralize managed.pty.kill synchronously BEFORE anything else
      // in this callback. node-pty's UnixTerminal has
      // `_socket.once('close', () => this.kill('SIGHUP'))` wired at destroy
      // time, and the master socket can emit 'close' concurrently with this
      // onExit on natural exit. If 'close' wins, SIGHUP targets the reaped
      // pid — recycled to an unrelated process on Linux (the typical relay
      // host). Synchronous neutralization closes that window. Windows is
      // exempt (WindowsTerminal.destroy uses kill() to close ConPTY).
      if (process.platform !== 'win32') {
        ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
      }
      // Why: If the PTY exits normally (or via SIGTERM), we must clear the
      // SIGKILL fallback timer to avoid firing SIGKILL later.
      if (managed.killTimer) {
        clearTimeout(managed.killTimer)
        managed.killTimer = undefined
      }
      this.dispatcher.notify('pty.exit', { id: managed.id, code: exitCode })
      this.notifyExitListener(managed)
      this.ptys.delete(managed.id)
      // Why: release the ptmx fd on the natural-exit path. Without this the
      // node-pty wrapper's _socket stays alive until GC and the master fd
      // leaks (see docs/fix-pty-fd-leak.md).
      disposeManagedPty(managed)
    })
  }

  private notifyExitListener(managed: ManagedPty): void {
    if (managed.exitListenerNotified) {
      return
    }
    managed.exitListenerNotified = true
    // Why: external observers own relay-hook cache eviction and plugin-overlay
    // cleanup. Natural exits, immediate shutdown, SIGKILL fallback, and relay
    // process disposal all need the same cleanup even when node-pty never
    // delivers onExit.
    if (this.exitListener) {
      try {
        this.exitListener({ id: managed.id, paneKey: managed.paneKey })
      } catch (err) {
        process.stderr.write(
          `[pty-handler] exit listener threw: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
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

    // Why: server-side augmenter values (ORCA_AGENT_HOOK_* and plugin overlay
    // dirs) override renderer-supplied env so live remote paths and hook coords
    // win over local userData paths. The context lets overlay augmenters derive
    // per-PTY OpenCode/Pi directories from the stable paneKey when present.
    const paneKey = typeof env?.ORCA_PANE_KEY === 'string' ? env.ORCA_PANE_KEY : undefined
    const spawnEnv = this.buildSpawnEnv(env, { id, paneKey, shell })
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv)

    // Why: SSH exec channels give the relay a minimal environment without
    // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
    // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
    // When overlays are injected, the launch wrapper keeps those paths after
    // user startup files re-export their defaults.
    const term = pty.spawn(shell, shellLaunch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...spawnEnv, ...shellLaunch.env }
    })

    // Why: capture the renderer-supplied paneKey on the managed entry so the
    // exit listener can evict per-pane caches without the relay needing a
    // separate ptyId→paneKey map. ORCA_PANE_KEY is shaped `${tabId}:${paneId}`
    // and is bounded by the renderer; the relay treats it as opaque.
    const tabId = typeof env?.ORCA_TAB_ID === 'string' ? env.ORCA_TAB_ID : undefined
    const worktreeId = typeof env?.ORCA_WORKTREE_ID === 'string' ? env.ORCA_WORKTREE_ID : undefined
    const managed: ManagedPty = {
      id,
      pty: term,
      initialCwd: cwd,
      buffered: '',
      paneKey,
      tabId,
      worktreeId
    }
    this.wireAndStore(managed)
    if (context?.isStale()) {
      // Why: if the client reconnected while pty.spawn was in flight, the
      // response is discarded and no renderer can own this PTY. Shut it down
      // immediately so it does not linger as an unreachable remote shell.
      term.kill('SIGTERM')
      managed.killTimer = setTimeout(() => {
        const still = this.ptys.get(id)
        if (still && !still.disposed) {
          still.pty.kill('SIGKILL')
          // Why: stale-spawn cleanup has no client who will ever attach. If
          // SIGKILL's onExit is missed (kernel edge case, uninterruptible
          // sleep), the managed entry + ptmx fd would leak forever. Dispose
          // synchronously so the entry is gone regardless of onExit timing.
          this.notifyExitListener(still)
          disposeManagedPty(still)
          this.ptys.delete(id)
        }
      }, 5000)
    }
    return { id }
  }

  private async attach(params: Record<string, unknown>): Promise<{ replay?: string }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    // Why: treat a disposed managed entry the same as "not found" — after
    // disposeManagedPty has run, managed.pty is torn down and any write/kill
    // would hit a neutralized no-op on POSIX. The explicit check converts a
    // silent failure into the existing error callers already handle.
    if (!managed || managed.disposed) {
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
    if (managed && !managed.disposed) {
      managed.pty.write(data)
    }
  }

  private resize(params: Record<string, unknown>): void {
    const id = params.id as string
    const cols = Math.max(1, Math.min(500, Math.floor(Number(params.cols) || 80)))
    const rows = Math.max(1, Math.min(500, Math.floor(Number(params.rows) || 24)))
    const managed = this.ptys.get(id)
    if (managed && !managed.disposed) {
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
      // Why: SIGKILL has already reaped the child; release the ptmx fd on the
      // same tick. Deferring to onExit leaves a window where the fd is live
      // with a dead child. Idempotent via the disposed guard — if onExit fires
      // later and also calls disposeManagedPty, the second call is a no-op.
      disposeManagedPty(managed)
      // Why: mirror the graceful-shutdown killTimer cleanup. If SIGKILL's
      // onExit never fires (kernel edge case: uninterruptible sleep,
      // D-state child on a bad NFS mount), the disposed managed entry would
      // linger in this.ptys forever. Each stranded entry consumes a slot in
      // the 50-PTY cap and is returned by listProcesses/serialize. Deleting
      // here makes the map hygiene a hard guarantee, not "hopefully onExit
      // runs". If onExit DOES fire later, its own `this.ptys.delete(id)` is
      // a no-op.
      this.notifyExitListener(managed)
      this.ptys.delete(id)
    } else {
      managed.pty.kill('SIGTERM')

      // Why: Some processes ignore SIGTERM (e.g. a hung child, a custom signal
      // handler). Without a SIGKILL fallback the PTY process would leak and the
      // managed entry would never be cleaned up. The 5-second window gives
      // well-behaved processes time to flush and exit gracefully. The timer is
      // cleared in the onExit handler if the process terminates on its own.
      // Do NOT call disposeManagedPty here: destroy()-right-after-SIGTERM
      // collapses the graceful-shutdown window and risks interrupting shell
      // EXIT traps. Fd release happens via onExit (natural exit) or via the
      // killTimer → SIGKILL → disposeManagedPty chain below.
      managed.killTimer = setTimeout(() => {
        const still = this.ptys.get(id)
        if (still && !still.disposed) {
          still.pty.kill('SIGKILL')
          // Why: emit pty.exit BEFORE disposeManagedPty sets disposed=true.
          // The natural onExit short-circuits on `managed.disposed`, so
          // without this notify the renderer never learns the pane is dead
          // when the SIGKILL fallback fires for a SIGTERM-ignoring child.
          this.dispatcher.notify('pty.exit', { id, code: -1 })
          // Why: if SIGKILL's onExit never fires (kernel edge case,
          // uninterruptible sleep, child wedged on a bad NFS mount), the
          // fd and map entry would leak forever. Dispose synchronously so
          // graceful-shutdown's SIGKILL fallback is a hard guarantee, not
          // "hopefully onExit will run". The disposed guard inside
          // disposeManagedPty makes a later onExit's dispose a no-op.
          this.notifyExitListener(still)
          disposeManagedPty(still)
          this.ptys.delete(id)
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
    // Why: POSIX disposeManagedPty neutralizes managed.pty.kill. Without the
    // disposed check, a post-dispose sendSignal would silently succeed (no
    // error, no action). Convert to the existing "not found" error.
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    managed.pty.kill(signal)
  }

  private async getCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return resolveProcessCwd(managed.pty.pid, managed.initialCwd)
  }

  private async getInitialCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return managed.initialCwd
  }

  private async clearBuffer(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (managed && !managed.disposed) {
      managed.pty.clear()
    }
  }

  private async hasChildProcesses(params: Record<string, unknown>): Promise<boolean> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      return false
    }
    return await processHasChildren(managed.pty.pid)
  }

  private async getForegroundProcess(params: Record<string, unknown>): Promise<string | null> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
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
      entries.push({
        id,
        pid,
        cols,
        rows,
        cwd: managed.initialCwd,
        paneKey: managed.paneKey,
        tabId: managed.tabId,
        worktreeId: managed.worktreeId
      })
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
      // Why: revive must apply the same hook env as spawn(). The hook-server
      // coords come from augmenters, while pane identity comes from the
      // serialized PTY entry because managed hook scripts exit without
      // ORCA_PANE_KEY.
      const revivedEnv: Record<string, string> = {}
      if (entry.paneKey) {
        revivedEnv.ORCA_PANE_KEY = entry.paneKey
      }
      if (entry.tabId) {
        revivedEnv.ORCA_TAB_ID = entry.tabId
      }
      if (entry.worktreeId) {
        revivedEnv.ORCA_WORKTREE_ID = entry.worktreeId
      }
      const shell = resolveDefaultShell()
      const spawnEnv = this.buildSpawnEnv(revivedEnv, {
        id: entry.id,
        paneKey: entry.paneKey,
        shell
      })
      const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv)
      const term = ptyMod.spawn(shell, shellLaunch.args, {
        name: 'xterm-256color',
        cols: entry.cols,
        rows: entry.rows,
        cwd: entry.cwd,
        env: { ...spawnEnv, ...shellLaunch.env }
      })
      this.wireAndStore({
        id: entry.id,
        pty: term,
        initialCwd: entry.cwd,
        buffered: '',
        paneKey: entry.paneKey,
        tabId: entry.tabId,
        worktreeId: entry.worktreeId
      })

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
    if (this.graceTimeMs === 0) {
      return
    }
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
        managed.killTimer = undefined
      }
      // Why: SIGKILL (not SIGTERM) before destroy. The relay process is
      // exiting; any SIGTERM-ignoring remote shell (editor with unsaved
      // buffers, a hung child with a bad handler, a process in
      // uninterruptible sleep) would survive SIGTERM + immediate destroy()
      // as an orphan on the remote host. SIGKILL is not ignorable and the
      // ptmx fd release via disposeManagedPty is synchronous, so there is
      // no graceful-shutdown window to preserve at this point.
      try {
        managed.pty.kill('SIGKILL')
      } catch {
        /* child may already be dead */
      }
      this.notifyExitListener(managed)
      disposeManagedPty(managed)
    }
    this.ptys.clear()
  }

  get activePtyCount(): number {
    return this.ptys.size
  }
}
