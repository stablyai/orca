/* oxlint-disable max-lines */
import type { IPty } from 'node-pty'
import type * as NodePty from 'node-pty'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWindowsGitBashShellPath } from '../main/git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../shared/windows-terminal-shell'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  resolveDefaultShell,
  resolveDefaultCwd,
  resolveProcessCwd,
  processHasChildren,
  getForegroundProcessName,
  isProcessAlive,
  listShellProfiles
} from './pty-shell-utils'
import { getRelayShellLaunchConfig } from './pty-shell-launch'
import { DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'
import { shouldUseShellReadyStartupDelivery } from '../shared/codex-startup-delivery'
import { buildStartupCommandSubmission } from '../shared/startup-command-submission'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { splitWorktreeId } from '../shared/worktree-id'
import { PhysicalExitTracker } from '../shared/physical-exit-tracker'
import {
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReady,
  type ShellReadyScanState
} from '../main/shell-ready-marker-scanner'
import { applyTerminalGitCredentialPromptGuard } from '../shared/terminal-git-credential-guard'
import {
  gitCredentialPromptGuardEnv,
  mergeGitConfigEnvProtocol
} from '../shared/git-credential-prompt-env'
import { isTuiAgent } from '../shared/tui-agent-config'
import { forceKillPosixPtyProcessGroups } from '../main/pty/posix-pty-process-groups'
import {
  PTY_STARTUP_INGRESS_VERSION,
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from '../shared/pty-startup-ingress'

function isMissingNodePtyNativeBinding(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Failed to load native module: (?:conpty|pty)\.node(?:,|$)/.test(error.message)
  )
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
  /** True once external cleanup observers have been notified. */
  exitListenerNotified?: boolean
  /** Renderer-supplied paneKey from spawn env (ORCA_PANE_KEY). Captured so
   *  external observers (the relay-hook-server cache) can evict per-pane
   *  state when this PTY exits. Symmetric with Orca's local pty.ts. */
  paneKey?: string
  tabId?: string
  /** Attach-only identity metadata supplied over RPC. Kept separate from
   *  paneKey/tabId because those fields also control shell env/revive hooks. */
  attachIdentity?: PtyIdentity
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  envToDelete: string[]
  gitCredentialPromptGuarded: boolean
  startupCommand?: ManagedStartupCommand
  physicalExit?: PhysicalExitTracker
  forceKillSent?: boolean
  gracefulKillSent?: boolean
  startupIngress?: PtyStartupIngress
  startupIngressIntent?: ReturnType<typeof parsePtyStartupIngressIntent>
}

type PendingPtyOutput = {
  data: string
  rawLength?: number
  transformed?: boolean
  seq?: number
}

type ManagedStartupCommand = {
  command: string
  delivered: boolean
  waitForShellReady: boolean
  scanState: ShellReadyScanState | null
  timer: ReturnType<typeof setTimeout> | null
}

// Why: node-pty's Windows agent throws "Signals not supported on windows." for
// any signal argument. ConPTY/winpty has no signal semantics — a bare kill()
// force-terminates the child — so drop the signal on Windows and forward it
// (SIGTERM graceful vs SIGKILL force) on POSIX.
function killPtyProcess(pty: IPty, signal: string): void {
  if (process.platform === 'win32') {
    pty.kill()
    return
  }
  if (signal === 'SIGKILL') {
    forceKillPosixPtyProcessGroups(pty.pid, () => pty.kill(signal))
    return
  }
  pty.kill(signal)
}

function finishPtyCreationOperations(operations: readonly (() => void)[]): void {
  // Why: the relay still targets Node 18, which lacks Array.prototype.toReversed.
  for (let index = operations.length - 1; index >= 0; index--) {
    operations[index]()
  }
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
  } else if (managed.gracefulKillSent || managed.forceKillSent) {
    // Why: WindowsTerminal.destroy() calls kill() internally; any prior bare
    // kill already closed ConPTY, so destroy would double-close the handle.
    return
  }
  try {
    ;(managed.pty as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow */
  }
}
const DEFAULT_GRACE_TIME_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
export const IMMEDIATE_PTY_EXIT_TIMEOUT_MS = 8_000
export const MAX_RELAY_PTY_SESSIONS = 50
export const REPLAY_BUFFER_MAX = 100 * 1024
const PTY_OUTPUT_BATCH_INTERVAL_MS = 8
const PTY_OUTPUT_DRAIN_CONTINUE_MS = 1
const PTY_OUTPUT_FLUSH_CHUNK_CHARS = 16 * 1024
const PTY_OUTPUT_FLUSH_MAX_WRITES = 2
const INTERACTIVE_OUTPUT_WINDOW_MS = 100
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
const INTERACTIVE_REDRAW_MAX_CHARS = PTY_OUTPUT_FLUSH_CHUNK_CHARS
const INTERACTIVE_OUTPUT_BUDGET_CHARS = 32 * 1024
const STARTUP_COMMAND_WRITE_DELAY_MS = 50
const STARTUP_COMMAND_SHELL_READY_FALLBACK_MS = 1500
const PTY_FORCE_KILL_RETRY_DELAY_MS = 250
const PTY_FORCE_KILL_MAX_ATTEMPTS = 2
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

const ALLOWED_WINDOWS_SHELL_OVERRIDES = new Set([
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'cmd',
  'wsl.exe',
  'wsl',
  WINDOWS_GIT_BASH_SHELL
])

function resolvePtyShellOverride(shellOverride: string): string {
  if (!shellOverride) {
    return ''
  }
  if (process.platform !== 'win32') {
    return ''
  }
  const normalized = shellOverride.toLowerCase()
  if (!ALLOWED_WINDOWS_SHELL_OVERRIDES.has(normalized)) {
    throw new Error(`Unsupported Windows shell override: ${shellOverride}`)
  }
  return resolveWindowsGitBashShellPath(shellOverride) ?? shellOverride
}

type PtyProcessSummary = {
  id: string
  cwd: string
  title: string
  worktreeId?: string
  terminalHandle?: string
}

type SerializedPtyEntry = {
  id: string
  pid: number
  cols: number
  rows: number
  cwd: string
  paneKey?: string
  tabId?: string
  attachIdentity?: PtyIdentity
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  envToDelete?: string[]
  /** Optional for state serialized by relays predating the credential guard. */
  gitCredentialPromptGuarded?: boolean
}

function sanitizeEnvToDelete(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
        .slice(0, 1_024)
    : []
}

export type PtyExitListener = (event: { id: string; paneKey?: string }) => void

type PtyIdentity = { paneKey?: string; tabId?: string }

/**
 * True when a reattach's expected pane identity contradicts the target PTY's
 * own. Used to reject cross-relay-generation id collisions: a reset relay mints
 * `pty-N` from 1 again, so an old lease's `pty-N` can name a different pane's
 * fresh PTY. Only compares fields present on *both* sides — absent identity on
 * either side is permissive so legacy PTYs and identity-less callers still attach.
 */
export function attachIdentityMismatches(expected: PtyIdentity, managed: PtyIdentity): boolean {
  return Boolean(
    (expected.paneKey && managed.paneKey && expected.paneKey !== managed.paneKey) ||
    (expected.tabId && managed.tabId && expected.tabId !== managed.tabId)
  )
}
/** Returns env to merge into the PTY's spawn env. Receives spawn context so
 *  augmenters that need a per-PTY identity (e.g. OPENCODE_CONFIG_DIR overlay
 *  paths derived from the renderer's paneKey) can compute it without pulling
 *  the renderer's env in twice. `command` is the renderer-chosen agent launch
 *  command (`pi`, `omp`, …) — supplied by ssh-pty-provider.ts so the Pi
 *  overlay can resolve the per-agent source dir without disk-presence
 *  guessing. NEVER undefined for client-driven spawns that target a
 *  Pi-compatible agent; may be undefined for CLI-launched bare shells. */
export type PtyEnvAugmenter = (ctx: {
  id: string
  paneKey?: string
  shell: string
  env: Record<string, string>
  command?: string
}) => Record<string, string>

export type RelayPtyWorktreeRemovalCoordinator = {
  beginWorktreePtySpawn(operationPath: string): () => void
}

export class PtyHandler {
  private ptys = new Map<string, ManagedPty>()
  private nextId = 1
  private dispatcher: RelayDispatcher
  private graceTimeMs: number
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingOutputByPty = new Map<string, PendingPtyOutput>()
  private lastInputAtByPty = new Map<string, number>()
  private interactiveOutputCharsByPty = new Map<string, number>()
  private pendingSpawnCount = 0
  private pendingReviveIds = new Set<string>()
  private creationFenced = false
  private pendingCreationDrainResolvers = new Set<() => void>()
  private worktreeRemovalCoordinator: RelayPtyWorktreeRemovalCoordinator | null = null
  private disposePromise: Promise<void> | null = null
  private ptyModule: typeof NodePty | null = null
  private ptyModuleLoadPromise: Promise<typeof NodePty | null> | null = null
  private reloadPtyModuleFromDisk = false
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

  private async loadPty(): Promise<typeof NodePty | null> {
    if (this.ptyModule) {
      return this.ptyModule
    }
    if (this.ptyModuleLoadPromise) {
      return this.ptyModuleLoadPromise
    }
    this.ptyModuleLoadPromise = this.loadPtyUncached()
    try {
      return await this.ptyModuleLoadPromise
    } finally {
      this.ptyModuleLoadPromise = null
    }
  }

  private async loadPtyUncached(): Promise<typeof NodePty | null> {
    if (!this.reloadPtyModuleFromDisk) {
      try {
        this.ptyModule = await import('node-pty')
        return this.ptyModule
      } catch {
        this.reloadPtyModuleFromDisk = true
      }
    }
    // Why: the relay is launched from its install dir today, but module
    // resolution must remain tied to the deployed bundle rather than cwd.
    const moduleEntry = join(__dirname, 'node_modules', 'node-pty', 'lib', 'index.js')
    if (!existsSync(moduleEntry)) {
      return null
    }
    try {
      this.ptyModule = require(moduleEntry) as typeof NodePty
      return this.ptyModule
    } catch {
      return null
    }
  }

  private invalidatePtyModuleAfterBindingFailure(): void {
    this.ptyModule = null
    this.reloadPtyModuleFromDisk = true
    const moduleRoot = join(__dirname, 'node_modules', 'node-pty')
    for (const cachedPath of Object.keys(require.cache)) {
      if (isPathInsideOrEqual(moduleRoot, cachedPath)) {
        delete require.cache[cachedPath]
      }
    }
  }

  setGraceTimeMs(graceTimeMs: number): void {
    this.graceTimeMs = Math.max(0, Math.floor(graceTimeMs))
  }

  setWorktreeRemovalCoordinator(coordinator: RelayPtyWorktreeRemovalCoordinator | null): void {
    this.worktreeRemovalCoordinator = coordinator
  }

  async shutdownForWorktreePath(rootPath: string): Promise<void> {
    const matchingIds = [...this.ptys.values()]
      .filter((managed) => {
        const ownedPath = managed.worktreeId
          ? splitWorktreeId(managed.worktreeId)?.worktreePath
          : undefined
        return (
          (ownedPath !== undefined && isPathInsideOrEqual(rootPath, ownedPath)) ||
          isPathInsideOrEqual(rootPath, managed.initialCwd)
        )
      })
      .map((managed) => managed.id)
    await Promise.all(matchingIds.map((id) => this.shutdown({ id, immediate: true })))
  }

  get configuredGraceTimeMs(): number {
    return this.graceTimeMs
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
    ctx: { id: string; paneKey?: string; shell: string; command?: string },
    envToDelete: readonly string[] = []
  ): Record<string, string> {
    const baseEnv = mergeGitConfigEnvProtocol(
      {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Orca',
        TERM_PROGRAM_VERSION:
          rendererEnv?.ORCA_APP_VERSION || process.env.ORCA_APP_VERSION || '0.0.0-dev',
        FORCE_HYPERLINK: '1'
      },
      rendererEnv
    ) as Record<string, string>
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
    const result = mergeGitConfigEnvProtocol(baseEnv, augmented) as Record<string, string>
    // Why: match local/daemon precedence so relay defaults and augmenters
    // cannot resurrect attribution or identity values explicitly removed.
    for (const key of envToDelete) {
      delete result[key]
    }
    if (
      !envToDelete.includes('TERM') &&
      rendererEnv &&
      Object.prototype.hasOwnProperty.call(rendererEnv, 'TERM')
    ) {
      result.TERM = rendererEnv.TERM
    }
    // Why: node-pty treats missing/empty TERM as its own platform-specific
    // default. Normalize here so POSIX and Windows relay children agree.
    if (!result.TERM) {
      result.TERM = 'xterm-256color'
    }
    return result
  }

  private clearStartupCommandTimer(managed: ManagedPty): void {
    if (managed.startupCommand?.timer) {
      clearTimeout(managed.startupCommand.timer)
      managed.startupCommand.timer = null
    }
  }

  private appendReplayBuffer(managed: ManagedPty, data: string): void {
    if (data.length === 0) {
      return
    }
    managed.buffered += data
    if (managed.buffered.length > REPLAY_BUFFER_MAX) {
      managed.buffered = managed.buffered.slice(-REPLAY_BUFFER_MAX)
    }
  }

  private releaseStartupCommand(managed: ManagedPty): void {
    this.clearStartupCommandTimer(managed)
    managed.startupCommand = undefined
  }

  private scheduleStartupCommandDelivery(managed: ManagedPty, delayMs: number): void {
    const startup = managed.startupCommand
    if (!startup || startup.delivered || managed.disposed) {
      return
    }
    this.clearStartupCommandTimer(managed)
    startup.timer = setTimeout(() => {
      startup.timer = null
      this.deliverStartupCommand(managed)
    }, delayMs)
  }

  private deliverStartupCommand(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup || startup.delivered || managed.disposed) {
      return
    }
    startup.delivered = true
    this.clearStartupCommandTimer(managed)
    if (startup.scanState) {
      const heldBytes = drainShellReadyHeldBytes(startup.scanState)
      if (heldBytes) {
        managed.startupIngress?.accept(heldBytes)
      }
    }
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: a multiline startup prompt is pasted literally via bracketed paste
    // only when the Orca shell-ready wrapper is active (waitForShellReady) —
    // that is the bash/zsh overlay that arms bracketed-paste mode. Other remote
    // shells keep the raw submit path so the ESC[200~ markers are not echoed.
    const payload = buildStartupCommandSubmission(startup.command, {
      submit,
      bracketedPasteSafe: startup.waitForShellReady
    })
    managed.startupCommand = undefined
    managed.pty.write(payload)
  }

  /** Wire onData/onExit listeners for a managed PTY and store it. */
  private wireAndStore(managed: ManagedPty): void {
    managed.physicalExit = new PhysicalExitTracker()
    this.ptys.set(managed.id, managed)
    const emitIngressData = (emission: PtyIngressEmission): void => {
      const rawLength = emission.rawEndSeq - emission.rawStartSeq
      this.appendReplayBuffer(managed, emission.data)
      this.enqueuePtyOutput(
        managed.id,
        emission.data,
        emission.transformed || rawLength !== emission.data.length
          ? { rawLength, seq: emission.rawEndSeq, transformed: true }
          : {}
      )
    }
    managed.startupIngress ??= new PtyStartupIngress({
      ...(managed.startupIngressIntent ? { intent: managed.startupIngressIntent } : {}),
      write: (data) => managed.pty.write(data),
      onEmission: emitIngressData
    })
    managed.pty.onData((data: string) => {
      const startup = managed.startupCommand
      if (startup?.waitForShellReady && startup.scanState && !startup.delivered) {
        const scanned = scanForShellReady(startup.scanState, data)
        data = scanned.output
        if (scanned.matched) {
          this.scheduleStartupCommandDelivery(managed, STARTUP_COMMAND_WRITE_DELAY_MS)
        }
      }
      managed.startupIngress?.accept(data)
    })
    managed.pty.onExit(({ exitCode }: { exitCode: number }) => {
      managed.physicalExit?.markExited()
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
      this.clearStartupCommandTimer(managed)
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(managed.id)
      this.dispatcher.notify('pty.exit', { id: managed.id, code: exitCode })
      this.notifyExitListener(managed)
      this.ptys.delete(managed.id)
      this.clearPtyFlowState(managed.id)
      // Why: release the ptmx fd on the natural-exit path. Without this the
      // node-pty wrapper's _socket stays alive until GC and the master fd
      // leaks (see docs/fix-pty-fd-leak.md).
      disposeManagedPty(managed)
    })
  }

  private releaseRelayIngress(managed: ManagedPty): void {
    const startupCommand = managed.startupCommand
    const scanState = startupCommand?.scanState
    if (scanState) {
      const held = drainShellReadyHeldBytes(scanState)
      startupCommand.scanState = null
      managed.startupIngress?.accept(held)
    }
    managed.startupIngress?.drainAndClose()
  }

  private notifyExitListener(managed: ManagedPty): void {
    if (managed.exitListenerNotified) {
      return
    }
    managed.exitListenerNotified = true
    // Why: external observers own relay-hook cache eviction and plugin-overlay
    // cleanup. Physical exits and whole-relay disposal both need it exactly once.
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
    this.dispatcher.onRequest('pty.closeStartupQueryAuthority', (p) =>
      this.closeStartupQueryAuthority(p)
    )

    this.dispatcher.onNotification('pty.data', (p) => this.writeData(p))
    this.dispatcher.onNotification('pty.resize', (p) => this.resize(p))
    this.dispatcher.onNotification('pty.ackData', (_p) => {
      /* flow control ack -- not yet enforced */
    })
  }

  private isLikelyInteractiveRedraw(data: string): boolean {
    if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
      return true
    }
    return data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b[')
  }

  private async closeStartupQueryAuthority(
    params: Record<string, unknown>
  ): Promise<{ appliedSeq: number }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return { appliedSeq: managed.startupIngress?.closeQueryAuthority() ?? 0 }
  }

  private shouldSendInteractiveOutputNow(id: string, data: string): boolean {
    const lastInputAt = this.lastInputAtByPty.get(id)
    const now = performance.now()
    if (lastInputAt === undefined || now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
      this.interactiveOutputCharsByPty.delete(id)
      return false
    }
    if (!this.isLikelyInteractiveRedraw(data)) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    const usedChars = this.interactiveOutputCharsByPty.get(id) ?? 0
    if (usedChars + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    this.interactiveOutputCharsByPty.set(id, usedChars + data.length)
    return true
  }

  private enqueuePtyOutput(
    id: string,
    data: string,
    meta: { rawLength?: number; transformed?: boolean; seq?: number } = {}
  ): void {
    const existing = this.pendingOutputByPty.get(id)
    if (meta.transformed === true) {
      // Why: transformed spans have no raw-to-clean slice mapping, so neither
      // side of their boundary may be folded into the relay's output batch.
      if (existing) {
        this.flushPtyOutput(id)
      }
      this.dispatcher.notify('pty.data', { id, data, ...meta })
      return
    }
    const pending: PendingPtyOutput = { data: (existing?.data ?? '') + data }
    if (existing?.rawLength !== undefined || meta.rawLength !== undefined) {
      pending.rawLength =
        (existing?.rawLength ?? existing?.data.length ?? 0) + (meta.rawLength ?? data.length)
    }
    if (meta.seq !== undefined) {
      pending.seq = meta.seq
    }
    if (this.shouldSendInteractiveOutputNow(id, pending.data)) {
      this.pendingOutputByPty.delete(id)
      this.clearOutputFlushTimerIfIdle()
      // Why: remote agent TUIs redraw around each keystroke. Background relay
      // batching should reduce SSH chatter, not add visible input echo delay.
      this.dispatcher.notify('pty.data', { id, ...pending })
      return
    }
    this.pendingOutputByPty.set(id, pending)
    this.scheduleOutputFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
  }

  private scheduleOutputFlush(delayMs: number): void {
    if (this.outputFlushTimer !== null) {
      return
    }
    this.outputFlushTimer = setTimeout(() => this.flushPendingOutput(), delayMs)
  }

  private flushPendingOutput(): void {
    this.outputFlushTimer = null
    let writes = 0
    for (const [id, pending] of Array.from(this.pendingOutputByPty.entries())) {
      if (writes >= PTY_OUTPUT_FLUSH_MAX_WRITES) {
        break
      }
      this.pendingOutputByPty.delete(id)
      const chunk = pending.transformed
        ? pending.data
        : pending.data.slice(0, PTY_OUTPUT_FLUSH_CHUNK_CHARS)
      const remaining = pending.transformed ? '' : pending.data.slice(PTY_OUTPUT_FLUSH_CHUNK_CHARS)
      if (remaining) {
        this.pendingOutputByPty.set(id, {
          data: remaining,
          ...(pending.rawLength === undefined ? {} : { rawLength: remaining.length }),
          seq: pending.seq
        })
      }
      const chunkRawLength = pending.transformed
        ? pending.rawLength
        : pending.rawLength === undefined
          ? undefined
          : chunk.length
      const chunkSeq =
        pending.seq === undefined ? undefined : pending.seq - (pending.data.length - chunk.length)
      this.dispatcher.notify('pty.data', {
        id,
        data: chunk,
        ...(chunkSeq === undefined ? {} : { seq: chunkSeq }),
        ...(chunkRawLength === undefined ? {} : { rawLength: chunkRawLength }),
        ...(pending.transformed ? { transformed: true } : {})
      })
      writes++
    }
    if (this.pendingOutputByPty.size > 0 && writes > 0) {
      // Why: relay-side output can arrive as a large single PTY chunk. Yield
      // between slices so client input and control frames can interleave.
      this.scheduleOutputFlush(PTY_OUTPUT_DRAIN_CONTINUE_MS)
    }
  }

  private flushPtyOutput(id: string): void {
    const pending = this.pendingOutputByPty.get(id)
    if (!pending) {
      return
    }
    this.pendingOutputByPty.delete(id)
    this.dispatcher.notify('pty.data', { id, ...pending })
    this.clearOutputFlushTimerIfIdle()
  }

  private clearOutputFlushTimerIfIdle(): void {
    if (this.pendingOutputByPty.size > 0 || this.outputFlushTimer === null) {
      return
    }
    clearTimeout(this.outputFlushTimer)
    this.outputFlushTimer = null
  }

  private clearPtyFlowState(id: string): void {
    this.pendingOutputByPty.delete(id)
    this.lastInputAtByPty.delete(id)
    this.interactiveOutputCharsByPty.delete(id)
    this.clearOutputFlushTimerIfIdle()
  }

  private beginPtyCreation(operationPaths: readonly (string | undefined)[]): () => void {
    if (this.creationFenced) {
      throw new Error('PTY handler is shutting down')
    }
    const distinctPaths = new Map<string, string>()
    for (const operationPath of operationPaths) {
      if (operationPath) {
        distinctPaths.set(normalizeRuntimePathForComparison(operationPath), operationPath)
      }
    }
    const finishRemovalOperations: (() => void)[] = []
    try {
      if (this.worktreeRemovalCoordinator) {
        for (const operationPath of distinctPaths.values()) {
          finishRemovalOperations.push(
            this.worktreeRemovalCoordinator.beginWorktreePtySpawn(operationPath)
          )
        }
      }
      if (this.ptys.size + this.pendingSpawnCount >= MAX_RELAY_PTY_SESSIONS) {
        throw new Error('Maximum number of PTY sessions reached (50)')
      }
    } catch (error) {
      // Why: worktree identity and cwd can belong to different roots. A later
      // rejection must release every earlier admission before propagating.
      finishPtyCreationOperations(finishRemovalOperations)
      throw error
    }
    this.pendingSpawnCount++
    let finished = false
    return () => {
      if (finished) {
        return
      }
      finished = true
      this.pendingSpawnCount--
      if (this.pendingSpawnCount === 0) {
        for (const resolve of this.pendingCreationDrainResolvers) {
          resolve()
        }
        this.pendingCreationDrainResolvers.clear()
      }
      finishPtyCreationOperations(finishRemovalOperations)
    }
  }

  private waitForPendingPtyCreations(): Promise<void> {
    if (this.pendingSpawnCount === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pendingCreationDrainResolvers.add(resolve)
    })
  }

  private async spawn(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<{ id: string }> {
    const env = params.env as Record<string, string> | undefined
    const worktreeId = env?.ORCA_WORKTREE_ID
    const worktreePath = worktreeId ? splitWorktreeId(worktreeId)?.worktreePath : undefined
    const cwd = typeof params.cwd === 'string' ? params.cwd : resolveDefaultCwd()
    const finishCreation = this.beginPtyCreation([worktreePath, cwd])
    try {
      return await this.spawnAfterAdmission(params, context)
    } finally {
      finishCreation()
    }
  }

  private async spawnAfterAdmission(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<{ id: string }> {
    const pty = await this.loadPty()
    if (!pty) {
      throw new Error('node-pty is not available on this remote host')
    }

    const cols = (params.cols as number) || 80
    const rows = (params.rows as number) || 24
    const cwd = (params.cwd as string) || resolveDefaultCwd()
    const env = params.env as Record<string, string> | undefined
    const envToDelete = sanitizeEnvToDelete(params.envToDelete)
    const explicitTerm =
      !envToDelete.includes('TERM') &&
      env &&
      Object.prototype.hasOwnProperty.call(env, 'TERM') &&
      typeof env.TERM === 'string' &&
      env.TERM.length > 0
        ? env.TERM
        : undefined
    const shellOverride =
      typeof params.shellOverride === 'string' ? params.shellOverride.trim() : ''
    const resolvedShellOverride = resolvePtyShellOverride(shellOverride)
    const shell = resolvedShellOverride || resolveDefaultShell()
    let id: string
    do {
      id = `pty-${this.nextId++}`
    } while (this.ptys.has(id) || this.pendingReviveIds.has(id))

    // Why: server-side augmenter values (ORCA_AGENT_HOOK_* and plugin overlay
    // dirs) override renderer-supplied env so live remote paths and hook coords
    // win over local userData paths. The context lets overlay augmenters derive
    // per-PTY OpenCode/Pi directories from the stable paneKey when present.
    // `command` is usually forwarded by ssh-pty-provider.ts only as a hint
    // for overlay resolution; runtime-owned PTYs opt into relay delivery
    // because no renderer TerminalPane exists to type the command.
    const paneKey = typeof env?.ORCA_PANE_KEY === 'string' ? env.ORCA_PANE_KEY : undefined
    // Why: kept so a restarted runtime can re-adopt this live PTY under its
    // originally-exported handle (reported via listProcesses, survives revive).
    const terminalHandle =
      typeof env?.ORCA_TERMINAL_HANDLE === 'string' ? env.ORCA_TERMINAL_HANDLE : undefined
    const command = typeof params.command === 'string' ? params.command : undefined
    const terminalWindowsWslDistro =
      typeof params.terminalWindowsWslDistro === 'string' ? params.terminalWindowsWslDistro : null
    const commandDelivery = params.commandDelivery === 'provider' ? 'provider' : 'renderer'
    const shouldProviderDeliverCommand = commandDelivery === 'provider' && command !== undefined
    const spawnEnv = this.buildSpawnEnv(env, { id, paneKey, shell, command }, envToDelete)
    const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(spawnEnv, command)
    // Why: SSH PTYs bypass main's host-env builder. Apply the policy only
    // after the relay merges its authoritative process environment so indexed
    // Git config and remote Windows/WSL behavior remain intact.
    const gitCredentialPromptGuarded = applyTerminalGitCredentialPromptGuard(spawnEnv, {
      launchCommand: launchCommandHint,
      isUnattended: isTuiAgent(params.launchAgent),
      platform: process.platform
    })
    const shouldEmitShellReadyMarker =
      launchCommandHint !== undefined &&
      shouldUseShellReadyStartupDelivery({
        command: launchCommandHint,
        startupCommandDelivery:
          params.startupCommandDelivery === 'shell-ready' ? 'shell-ready' : undefined
      })
    // Why: renderer- and provider-delivered startup commands both use this
    // marker; the side responsible for delivery also strips it from output.
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv, process.platform, {
      terminalWindowsWslDistro,
      emitReadyMarker: shouldEmitShellReadyMarker
    })

    // Why: SSH exec channels give the relay a minimal environment without
    // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
    // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
    // When overlays are injected, the launch wrapper keeps those paths after
    // user startup files re-export their defaults.
    let term: IPty
    try {
      term = pty.spawn(shell, shellLaunch.args, {
        // Why: node-pty overwrites env.TERM with `name`; keep caller-selected
        // terminal identities instead of losing them at the final spawn boundary.
        name: spawnEnv.TERM ?? 'xterm-256color',
        cols,
        rows,
        cwd,
        // Why: relay shells inherit process.env; never let an ambient Orca marker
        // enable shell-ready behavior unless this spawn explicitly requested it.
        env: { ...spawnEnv, ORCA_SHELL_READY_MARKER: '0', ...shellLaunch.env }
      })
    } catch (error) {
      // Why: Windows node-pty loads conpty.node only on first spawn, after the
      // wrapper import succeeded. Keep that late failure on the degraded path.
      if (isMissingNodePtyNativeBinding(error)) {
        this.invalidatePtyModuleAfterBindingFailure()
        throw new Error('node-pty is not available on this remote host')
      }
      throw error
    }

    // Why: capture the renderer-supplied paneKey on the managed entry so the
    // exit listener can evict per-pane caches without the relay needing a
    // separate ptyId→paneKey map. ORCA_PANE_KEY is shaped `${tabId}:${paneId}`
    // and is bounded by the renderer; the relay treats it as opaque.
    const tabId = typeof env?.ORCA_TAB_ID === 'string' ? env.ORCA_TAB_ID : undefined
    const attachIdentity = {
      paneKey: typeof params.paneKey === 'string' ? params.paneKey : paneKey,
      tabId: typeof params.tabId === 'string' ? params.tabId : tabId
    }
    const worktreeId = typeof env?.ORCA_WORKTREE_ID === 'string' ? env.ORCA_WORKTREE_ID : undefined
    const startupIngressIntent =
      params.startupIngressVersion === PTY_STARTUP_INGRESS_VERSION
        ? parsePtyStartupIngressIntent(params.startupIngress, {
            allowWindowsEchoProjection: false
          })
        : undefined
    const managed: ManagedPty = {
      id,
      pty: term,
      initialCwd: cwd,
      buffered: '',
      paneKey,
      tabId,
      ...(attachIdentity.paneKey || attachIdentity.tabId ? { attachIdentity } : {}),
      worktreeId,
      ...(explicitTerm !== undefined ? { explicitTerm } : {}),
      envToDelete,
      gitCredentialPromptGuarded,
      ...(startupIngressIntent ? { startupIngressIntent } : {}),
      ...(terminalHandle ? { terminalHandle } : {}),
      ...(shouldProviderDeliverCommand
        ? {
            startupCommand: {
              command,
              delivered: false,
              waitForShellReady: shellLaunch.env.ORCA_SHELL_READY_MARKER === '1',
              scanState:
                shellLaunch.env.ORCA_SHELL_READY_MARKER === '1'
                  ? createShellReadyScanState()
                  : null,
              timer: null
            }
          }
        : {})
    }
    this.wireAndStore(managed)
    if (context?.isStale()) {
      // Why: if the client reconnected while pty.spawn was in flight, the
      // response is discarded and no renderer can own this PTY. Shut it down
      // immediately so it does not linger as an unreachable remote shell.
      this.releaseStartupCommand(managed)
      this.requestGracefulKill(managed, 'terminate stale')
    } else if (managed.startupCommand) {
      this.scheduleStartupCommandDelivery(
        managed,
        managed.startupCommand.waitForShellReady
          ? STARTUP_COMMAND_SHELL_READY_FALLBACK_MS
          : STARTUP_COMMAND_WRITE_DELAY_MS
      )
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

    // Why: a reattach can arrive for a relay PTY whose backing shell already
    // died without node-pty delivering onExit (e.g. the child was reaped out of
    // band while the SSH channel was down). The map entry lingers, so attach
    // would otherwise "succeed" with an empty replay and strand the reattached
    // pane on a black, unresponsive shell. Prove liveness here; if the pid is
    // provably gone, reap the stale entry and report not-found so the caller
    // drops the dead lease and spawns fresh — the same recovery path an expired
    // grace window already takes.
    if (managed.pty.pid && !isProcessAlive(managed.pty.pid)) {
      managed.physicalExit?.markExited()
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(id)
      this.notifyExitListener(managed)
      disposeManagedPty(managed)
      this.ptys.delete(id)
      this.clearPtyFlowState(id)
      throw new Error(`PTY "${id}" not found`)
    }

    // Why: PTY ids are a per-relay-process counter (pty-1, pty-2, …). When the
    // relay changes generation — an app update deploys a new content-hashed
    // relay dir, or a grace-expired relay restarts — the counter resets, so an
    // old lease's `pty-N` can name a freshly spawned `pty-N` that belongs to a
    // *different* pane. Attaching by id alone then wires a tab to the wrong
    // shell. Reject when the caller's expected identity disagrees with this
    // PTY's own so the client falls back to a fresh spawn. Absent identity on
    // either side stays permissive for backward compatibility.
    const mismatch = attachIdentityMismatches(
      {
        paneKey: typeof params.expectedPaneKey === 'string' ? params.expectedPaneKey : undefined,
        tabId: typeof params.expectedTabId === 'string' ? params.expectedTabId : undefined
      },
      managed.attachIdentity ?? { paneKey: managed.paneKey, tabId: managed.tabId }
    )
    if (mismatch) {
      throw new Error(`PTY "${id}" not found (identity mismatch)`)
    }

    managed.startupIngress?.snapshotBarrier()

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
      // Why: relay batching may still hold bytes that are already included in
      // the full replay buffer. Drop that pending notification before attach
      // so reconnect/suppressed replay cannot render the same bytes twice.
      this.pendingOutputByPty.delete(id)
      this.clearOutputFlushTimerIfIdle()
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
      this.lastInputAtByPty.set(id, performance.now())
      this.interactiveOutputCharsByPty.set(id, 0)
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
      this.releaseStartupCommand(managed)
      this.flushPtyOutput(id)
      this.requestForceKill(managed)
      // Why: remote Git deletion must not race native handles still owned by
      // an uninterruptible child. Timeout rejects but deliberately keeps the
      // map entry so a later onExit or retry retains the physical owner.
      await this.waitForPhysicalExit(managed, IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
    } else {
      this.releaseStartupCommand(managed)
      this.requestGracefulKill(managed, 'force-kill')
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

  private waitForPhysicalExit(managed: ManagedPty, timeoutMs: number): Promise<void> {
    const physicalExit = managed.physicalExit
    if (!physicalExit) {
      return Promise.reject(new Error(`PTY "${managed.id}" exit tracking unavailable`))
    }
    return physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${managed.id}`)
    )
  }

  private requestGracefulKill(
    managed: ManagedPty,
    fallbackAction: 'terminate stale' | 'force-kill'
  ): void {
    if (managed.gracefulKillSent) {
      return
    }
    managed.gracefulKillSent = true
    if (process.platform === 'win32') {
      // Why: bare node-pty kill is already force-final on ConPTY, so no later
      // fallback, immediate cleanup, or destroy may close the handle again.
      managed.forceKillSent = true
    }
    try {
      killPtyProcess(managed.pty, 'SIGTERM')
    } catch (error) {
      managed.gracefulKillSent = false
      managed.forceKillSent = false
      throw error
    }
    if (process.platform === 'win32') {
      return
    }
    // Why: POSIX children may ignore SIGTERM; only onExit releases ownership
    // after the bounded SIGKILL fallback.
    this.armForceKillFallback(managed, fallbackAction, 5000, PTY_FORCE_KILL_MAX_ATTEMPTS)
  }

  private armForceKillFallback(
    managed: ManagedPty,
    fallbackAction: 'terminate stale' | 'force-kill',
    delayMs: number,
    attemptsRemaining: number
  ): void {
    managed.killTimer = setTimeout(() => {
      managed.killTimer = undefined
      const still = this.ptys.get(managed.id)
      if (!still || still.disposed) {
        return
      }
      try {
        this.requestForceKill(still)
      } catch (error) {
        process.stderr.write(
          `[pty-handler] failed to ${fallbackAction} PTY ${managed.id}: ${error instanceof Error ? error.message : String(error)}\n`
        )
        // Why: a transient native SIGKILL failure must not strand an
        // unreachable remote shell after the only cleanup owner returned.
        if (attemptsRemaining > 1 && this.ptys.get(still.id) === still && !still.disposed) {
          this.armForceKillFallback(
            still,
            fallbackAction,
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            attemptsRemaining - 1
          )
        }
      }
    }, delayMs)
  }

  private requestForceKill(managed: ManagedPty): void {
    if (managed.forceKillSent || (process.platform === 'win32' && managed.gracefulKillSent)) {
      return
    }
    managed.forceKillSent = true
    try {
      killPtyProcess(managed.pty, 'SIGKILL')
    } catch (error) {
      managed.forceKillSent = false
      throw error
    }
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
      managed.startupIngress?.snapshotBarrier()
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
    return await getForegroundProcessName(managed.pty.pid, managed.pty.process || null)
  }

  private async listProcesses(): Promise<PtyProcessSummary[]> {
    const results: PtyProcessSummary[] = []
    for (const [id, managed] of this.ptys) {
      const title =
        (await getForegroundProcessName(managed.pty.pid, managed.pty.process || null)) || 'shell'
      results.push({
        id,
        cwd: managed.initialCwd,
        title,
        ...(managed.worktreeId ? { worktreeId: managed.worktreeId } : {}),
        ...(managed.terminalHandle ? { terminalHandle: managed.terminalHandle } : {})
      })
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
        attachIdentity: managed.attachIdentity,
        worktreeId: managed.worktreeId,
        ...(managed.explicitTerm !== undefined ? { explicitTerm: managed.explicitTerm } : {}),
        envToDelete: managed.envToDelete,
        gitCredentialPromptGuarded: managed.gitCredentialPromptGuarded,
        ...(managed.terminalHandle ? { terminalHandle: managed.terminalHandle } : {})
      })
    }
    return JSON.stringify(entries)
  }

  private async revive(params: Record<string, unknown>): Promise<void> {
    const state = params.state as string
    const entries = JSON.parse(state) as SerializedPtyEntry[]

    for (const entry of entries) {
      if (this.ptys.has(entry.id) || this.pendingReviveIds.has(entry.id)) {
        continue
      }
      // Only re-attach if the original process is still alive
      try {
        process.kill(entry.pid, 0)
      } catch {
        continue
      }
      const ownedPath = entry.worktreeId
        ? splitWorktreeId(entry.worktreeId)?.worktreePath
        : undefined
      const finishCreation = this.beginPtyCreation([ownedPath, entry.cwd])
      this.pendingReviveIds.add(entry.id)
      try {
        await this.reviveEntry(entry)
      } finally {
        this.pendingReviveIds.delete(entry.id)
        finishCreation()
      }
    }
  }

  private async reviveEntry(entry: SerializedPtyEntry): Promise<void> {
    const ptyMod = await this.loadPty()
    if (!ptyMod) {
      return
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
    if (entry.terminalHandle) {
      revivedEnv.ORCA_TERMINAL_HANDLE = entry.terminalHandle
    }
    const explicitTerm =
      typeof entry.explicitTerm === 'string' && entry.explicitTerm.length > 0
        ? entry.explicitTerm
        : undefined
    if (explicitTerm !== undefined) {
      revivedEnv.TERM = explicitTerm
    }
    // Why: serialized state can come from an older or untrusted client, so
    // revive reapplies the same bounds as a fresh spawn before retaining it.
    const envToDelete = sanitizeEnvToDelete(entry.envToDelete)
    const shell = resolveDefaultShell()
    const spawnEnv = this.buildSpawnEnv(
      revivedEnv,
      { id: entry.id, paneKey: entry.paneKey, shell },
      envToDelete
    )
    // Why: revive lacks the original launch command, so preserve the guard
    // decision made at fresh spawn. Legacy state remains an ordinary shell.
    const gitCredentialPromptGuarded = entry.gitCredentialPromptGuarded === true
    if (gitCredentialPromptGuarded) {
      Object.assign(spawnEnv, gitCredentialPromptGuardEnv(spawnEnv, process.platform))
    }
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv)
    const term = ptyMod.spawn(shell, shellLaunch.args, {
      name: spawnEnv.TERM ?? 'xterm-256color',
      cols: entry.cols,
      rows: entry.rows,
      cwd: entry.cwd,
      // Why: no provider-delivered command is waiting for a ready marker.
      env: { ...spawnEnv, ORCA_SHELL_READY_MARKER: '0', ...shellLaunch.env }
    })
    this.wireAndStore({
      id: entry.id,
      pty: term,
      initialCwd: entry.cwd,
      buffered: '',
      paneKey: entry.paneKey,
      tabId: entry.tabId,
      attachIdentity: entry.attachIdentity,
      worktreeId: entry.worktreeId,
      ...(explicitTerm !== undefined ? { explicitTerm } : {}),
      envToDelete,
      gitCredentialPromptGuarded,
      ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {})
    })

    const match = entry.id.match(/^pty-(\d+)$/)
    if (match) {
      this.nextId = Math.max(this.nextId, Number.parseInt(match[1], 10) + 1)
    }
  }

  startGraceTimer(onExpire: () => void, timeoutMs = this.graceTimeMs): void {
    this.cancelGraceTimer()
    if (timeoutMs === 0) {
      return
    }
    // Why: callers may shorten the first empty-detached startup window, but
    // connected relays still use the configured grace so live PTYs can survive
    // app restarts and reconnects.
    this.graceTimer = setTimeout(() => {
      onExpire()
    }, timeoutMs)
  }

  cancelGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  dispose(options: { waitForPhysicalExit?: boolean } = {}): Promise<void> {
    // Why: fence creation synchronously before the first await so a spawn or
    // revive cannot appear after the disposal snapshot and escape process exit.
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    const disposePromise = this.disposePtys(options.waitForPhysicalExit !== false)
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Why: a rejected native kill retains ownership so a later shutdown
      // signal can retry instead of joining a permanently rejected promise.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }

  private async disposePtys(waitForPhysicalExit: boolean): Promise<void> {
    this.cancelGraceTimer()
    await this.waitForPendingPtyCreations()
    for (const managed of this.ptys.values()) {
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(managed.id)
    }
    if (this.outputFlushTimer !== null) {
      clearTimeout(this.outputFlushTimer)
      this.outputFlushTimer = null
    }
    this.pendingOutputByPty.clear()
    this.lastInputAtByPty.clear()
    this.interactiveOutputCharsByPty.clear()
    const results = await Promise.allSettled(
      [...this.ptys.values()].map((managed) =>
        this.disposePtyForRelayShutdown(managed, waitForPhysicalExit)
      )
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (rejected) {
      throw rejected.reason
    }
  }

  private async disposePtyForRelayShutdown(
    managed: ManagedPty,
    waitForPhysicalExit: boolean
  ): Promise<void> {
    if (managed.killTimer) {
      clearTimeout(managed.killTimer)
      managed.killTimer = undefined
    }
    this.clearStartupCommandTimer(managed)
    this.releaseRelayIngress(managed)
    // Why: relay exit must retain the native owner until SIGKILL is accepted
    // (with one bounded retry) or onExit proves the process is already gone.
    await this.requestForceKillForRelayShutdown(managed)
    if (waitForPhysicalExit && this.ptys.get(managed.id) === managed && !managed.disposed) {
      try {
        await this.waitForPhysicalExit(managed, IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
      } catch {
        // An accepted SIGKILL is the bounded final boundary when a child is
        // uninterruptible and cannot report exit before relay shutdown.
      }
    }
    if (this.ptys.get(managed.id) === managed && !managed.disposed) {
      this.notifyExitListener(managed)
      disposeManagedPty(managed)
      this.ptys.delete(managed.id)
      this.clearPtyFlowState(managed.id)
    }
  }

  private async requestForceKillForRelayShutdown(managed: ManagedPty): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < PTY_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      if (this.ptys.get(managed.id) !== managed || managed.disposed) {
        return
      }
      try {
        this.requestForceKill(managed)
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < PTY_FORCE_KILL_MAX_ATTEMPTS) {
        const tracker = managed.physicalExit
        if (!tracker) {
          throw lastError
        }
        try {
          await tracker.waitForExit(
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            () => new Error(`Retrying force-kill for PTY ${managed.id}`)
          )
          return
        } catch {
          // The bounded waiter detached; retry the still-owned native handle.
        }
      }
    }
    throw lastError
  }

  get activePtyCount(): number {
    return this.ptys.size
  }

  get retainedStartupCommandCount(): number {
    let count = 0
    for (const managed of this.ptys.values()) {
      if (managed.startupCommand) {
        count += 1
      }
    }
    return count
  }

  get graceTimerActive(): boolean {
    return this.graceTimer !== null
  }
}
