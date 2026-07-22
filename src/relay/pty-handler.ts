/* oxlint-disable max-lines */
import type { IPty } from 'node-pty'
import type * as NodePty from 'node-pty'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { stripInheritedBuildModeEnv } from '../main/pty/build-mode-env'
import {
  PTY_STARTUP_INGRESS_VERSION,
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from '../shared/pty-startup-ingress'
import { resolvePtyOwnerBackend, type PtyOwnerBackend } from '../shared/pty-owner-backend'
import {
  agentSessionOwnerBindingsEqual,
  ClaimedAgentPtyOwnerRegistry
} from '../shared/claimed-agent-pty-owner'
import {
  AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION,
  AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION,
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding,
  type AgentSessionOwnerBinding
} from '../shared/agent-session-host-authority'

function isMissingNodePtyNativeBinding(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Failed to load native module: (?:conpty|pty)\.node(?:,|$)/.test(error.message)
  )
}

type ManagedPty = {
  id: string
  incarnationId: string
  pty: IPty
  initialCwd: string
  buffered: string
  /** Timer for SIGKILL fallback after a graceful SIGTERM shutdown. */
  killTimer?: ReturnType<typeof setTimeout>
  /** True once disposeManagedPty has run; blocks double-dispose and makes post-dispose calls fail "not found" not silently. */
  disposed?: boolean
  /** True once external cleanup observers have been notified. */
  exitListenerNotified?: boolean
  /** Renderer-supplied paneKey (ORCA_PANE_KEY); captured so exit observers can evict per-pane cache state. */
  paneKey?: string
  tabId?: string
  /** Attach-only identity metadata (RPC). Separate from paneKey/tabId, which also drive shell env/revive hooks. */
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
  ownerBackend: PtyOwnerBackend
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

type RelayAgentSessionCreateResult = {
  id: string
  incarnationId: string
  replay?: string
  agentSessionEnsure?: unknown
}

const AGENT_SESSION_CREATE_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const AGENT_SESSION_CREATE_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000
const AGENT_SESSION_CREATE_OPERATION_LIMIT = 4_096

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

// Why: node-pty's Windows agent throws on any signal arg (ConPTY has no signal semantics); drop it there, forward on POSIX.
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
  // Why: clear the SIGKILL fallback timer so it can't fire pty.kill on an already-disposed instance.
  if (managed.killTimer) {
    clearTimeout(managed.killTimer)
    managed.killTimer = undefined
  }
  // Why: neutralize pty.kill before destroy() so UnixTerminal's async 'close' SIGHUP can't hit a recycled pid.
  // Windows exempt: its destroy() IS a kill() (via _deferNoArgs), so neutralizing leaks the ConPTY agent.
  if (process.platform !== 'win32') {
    ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
  } else if (managed.gracefulKillSent || managed.forceKillSent) {
    // Why: WindowsTerminal.destroy() calls kill(); a prior bare kill already closed ConPTY, so skip to avoid double-close.
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
  incarnationId: string
  cwd: string
  title: string
  worktreeId?: string
  terminalHandle?: string
  agentSessionOwners?: AgentSessionOwnerBinding[]
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
  agentSessionOwners?: AgentSessionOwnerBinding[]
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
 * True when a reattach's expected pane identity contradicts the target PTY's own.
 * Rejects cross-relay-generation id collisions (a reset relay reuses `pty-N`).
 * Only compares fields present on both sides; absent identity stays permissive.
 */
export function attachIdentityMismatches(expected: PtyIdentity, managed: PtyIdentity): boolean {
  return Boolean(
    (expected.paneKey && managed.paneKey && expected.paneKey !== managed.paneKey) ||
    (expected.tabId && managed.tabId && expected.tabId !== managed.tabId)
  )
}
/** Returns env to merge into the PTY's spawn env. Receives spawn context so augmenters can derive per-PTY identity from paneKey.
 *  `command` is the renderer-chosen agent launch command (`pi`, `omp`, …); undefined for CLI-launched bare shells. */
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
  // Why: single optional slot is intentional — callers compose externally; a throw is swallowed so it can't block cleanup.
  private exitListener: PtyExitListener | null = null
  // Why: env augmenters run on every spawn so each PTY sees live hook coords without the dispatcher knowing about agent hooks.
  private envAugmenters: PtyEnvAugmenter[] = []
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionCreateOperations = new Map<
    string,
    Promise<RelayAgentSessionCreateResult>
  >()

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
    // Why: tie module resolution to the deployed bundle dir, not cwd.
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

  /** Subscribe to PTY-exit events (relay-hook server uses this to evict per-paneKey caches). */
  setExitListener(listener: PtyExitListener | null): void {
    this.exitListener = listener
  }

  /** Register an env augmenter merged into every spawn env *after* process.env and renderer env.
   *  Used by the relay-hook server to inject ORCA_AGENT_HOOK_* coords. See docs/design/agent-status-over-ssh.md §3. */
  addEnvAugmenter(augmenter: PtyEnvAugmenter): () => void {
    this.envAugmenters.push(augmenter)
    return () => {
      const idx = this.envAugmenters.indexOf(augmenter)
      if (idx !== -1) {
        this.envAugmenters.splice(idx, 1)
      }
    }
  }

  /** Build augmented spawn env; augmenter values win over process.env/renderer env. Shared by spawn()/revive() so precedence can't drift. */
  private buildSpawnEnv(
    rendererEnv: Record<string, string> | undefined,
    ctx: { id: string; paneKey?: string; shell: string; command?: string },
    envToDelete: readonly string[] = []
  ): Record<string, string> {
    const baseEnv = mergeGitConfigEnvProtocol(
      {
        ...stripInheritedBuildModeEnv(process.env),
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
    // Why: match local/daemon precedence so defaults/augmenters can't resurrect explicitly-removed values.
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
    // Why: node-pty defaults missing/empty TERM per-platform; normalize so POSIX and Windows children agree.
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
    // Why: only the shell-ready wrapper arms bracketed-paste; other shells use raw submit so ESC[200~ markers aren't echoed.
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
      ownerBackend: managed.ownerBackend,
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
      // Why: neutralize pty.kill synchronously so node-pty's 'close' SIGHUP can't hit a recycled pid on POSIX.
      if (process.platform !== 'win32') {
        ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
      }
      // Why: clear the SIGKILL fallback timer on clean exit so it doesn't fire later.
      if (managed.killTimer) {
        clearTimeout(managed.killTimer)
        managed.killTimer = undefined
      }
      this.clearStartupCommandTimer(managed)
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(managed.id)
      this.dispatcher.notify('pty.exit', {
        id: managed.id,
        code: exitCode,
        incarnationId: managed.incarnationId
      })
      this.notifyExitListener(managed)
      this.agentSessionOwners.release(managed.id)
      this.ptys.delete(managed.id)
      this.clearPtyFlowState(managed.id)
      // Why: release the ptmx fd on natural exit, else the master fd leaks until GC (docs/fix-pty-fd-leak.md).
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
    // Why: notify exactly once — both physical exit and whole-relay disposal reach here.
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
    this.dispatcher.onRequest('pty.getSize', (p) => this.getSize(p))
    this.dispatcher.onRequest('pty.clearBuffer', (p) => this.clearBuffer(p))
    this.dispatcher.onRequest('pty.hasChildProcesses', (p) => this.hasChildProcesses(p))
    this.dispatcher.onRequest('pty.getForegroundProcess', (p) => this.getForegroundProcess(p))
    this.dispatcher.onRequest('pty.getCapabilities', async () => ({
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION,
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    }))
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
      // Why: transformed spans lack a raw-to-clean slice mapping, so they can't be folded into the output batch.
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
      // Why: send interactive echo immediately — batching must not add visible input delay for TUIs.
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
      // Why: yield between slices of a large chunk so client input and control frames can interleave.
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
      // Why: a later rejection must release every earlier admission before propagating.
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
  ): Promise<RelayAgentSessionCreateResult> {
    const operationId = params.agentSessionCreateOperationId
    if (operationId === undefined) {
      return await this.spawnOnce(params, context)
    }
    if (
      typeof operationId !== 'string' ||
      !AGENT_SESSION_CREATE_OPERATION_ID_PATTERN.test(operationId)
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const existing = this.agentSessionCreateOperations.get(operationId)
    if (existing) {
      return await existing
    }
    if (this.agentSessionCreateOperations.size >= AGENT_SESSION_CREATE_OPERATION_LIMIT) {
      throw new Error('agent_session_operation_capacity')
    }
    const operation = this.spawnOnce(params, context)
    this.agentSessionCreateOperations.set(operationId, operation)
    try {
      const result = await operation
      this.expireAgentSessionCreateOperation(operationId, operation)
      return result
    } catch (error) {
      const outcomeUnknown =
        typeof error === 'object' &&
        error !== null &&
        'agentSessionOperationOutcome' in error &&
        error.agentSessionOperationOutcome === 'unknown'
      if (outcomeUnknown) {
        // Why: the native PTY may be live; replay the same failure instead of spawning again.
        this.expireAgentSessionCreateOperation(operationId, operation)
      } else if (this.agentSessionCreateOperations.get(operationId) === operation) {
        this.agentSessionCreateOperations.delete(operationId)
      }
      throw error
    }
  }

  private expireAgentSessionCreateOperation(
    operationId: string,
    operation: Promise<RelayAgentSessionCreateResult>
  ): void {
    const timer = setTimeout(() => {
      if (this.agentSessionCreateOperations.get(operationId) === operation) {
        this.agentSessionCreateOperations.delete(operationId)
      }
    }, AGENT_SESSION_CREATE_OPERATION_RETENTION_MS)
    timer.unref?.()
  }

  private async spawnOnce(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<RelayAgentSessionCreateResult> {
    const env = params.env as Record<string, string> | undefined
    const worktreeId = env?.ORCA_WORKTREE_ID
    const worktreePath = worktreeId ? splitWorktreeId(worktreeId)?.worktreePath : undefined
    const cwd = typeof params.cwd === 'string' ? params.cwd : resolveDefaultCwd()
    const finishCreation = this.beginPtyCreation([worktreePath, cwd])
    let physicalSpawnCommitted = false
    const markPhysicalSpawnCommitted = (): void => {
      physicalSpawnCommitted = true
    }
    try {
      const ensure = params.agentSessionEnsure as { claim?: unknown; surface?: unknown } | undefined
      if (!ensure) {
        return await this.spawnAfterAdmission(params, context, markPhysicalSpawnCommitted)
      }
      if (
        !isAgentSessionExecutionClaim(ensure.claim) ||
        !isAgentSessionSurfaceBinding(ensure.surface)
      ) {
        throw new Error('agent_session_identity_required')
      }
      const claim = ensure.claim
      const surface = ensure.surface
      const result = await this.agentSessionOwners.ensure({
        claim,
        surface,
        spawn: async ({ generation }) => {
          const created = await this.spawnAfterAdmission(
            params,
            context,
            markPhysicalSpawnCommitted
          )
          const managed = this.ptys.get(created.id)
          if (managed) {
            managed.agentSessionOwners = [
              {
                claim,
                generation,
                phase: 'live',
                ptyId: created.id,
                surface
              }
            ]
          }
          return { ptyId: created.id }
        },
        isLive: (owner) => {
          const managed = this.ptys.get(owner.ptyId)
          return Boolean(
            managed &&
            !managed.disposed &&
            (!managed.pty.pid || isProcessAlive(managed.pty.pid)) &&
            managed.agentSessionOwners?.some((candidate) =>
              agentSessionOwnerBindingsEqual(candidate, owner)
            )
          )
        }
      })
      const managed = this.ptys.get(result.owner.ptyId)
      if (!managed || managed.disposed) {
        this.agentSessionOwners.release(result.owner.ptyId, result.owner.generation)
        throw new Error('agent_session_exited_during_start')
      }
      managed.agentSessionOwners = this.agentSessionOwners.listForPty(managed.id)
      return {
        id: managed.id,
        incarnationId: managed.incarnationId,
        agentSessionEnsure: result,
        ...(result.disposition === 'adopted' && managed.buffered
          ? { replay: managed.buffered }
          : {})
      }
    } catch (error) {
      if (!physicalSpawnCommitted) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(message), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    } finally {
      finishCreation()
    }
  }

  private async spawnAfterAdmission(
    params: Record<string, unknown>,
    context?: RequestContext,
    onPhysicalSpawnCommitted?: () => void
  ): Promise<{ id: string; incarnationId: string }> {
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

    // Why: augmenter values override renderer env so remote paths and hook coords win over local userData.
    const paneKey = typeof env?.ORCA_PANE_KEY === 'string' ? env.ORCA_PANE_KEY : undefined
    // Why: kept so a restarted runtime can re-adopt this PTY under its original handle (survives revive).
    const terminalHandle =
      typeof env?.ORCA_TERMINAL_HANDLE === 'string' ? env.ORCA_TERMINAL_HANDLE : undefined
    const command = typeof params.command === 'string' ? params.command : undefined
    const terminalWindowsWslDistro =
      typeof params.terminalWindowsWslDistro === 'string' ? params.terminalWindowsWslDistro : null
    const commandDelivery = params.commandDelivery === 'provider' ? 'provider' : 'renderer'
    const shouldProviderDeliverCommand = commandDelivery === 'provider' && command !== undefined
    const spawnEnv = this.buildSpawnEnv(env, { id, paneKey, shell, command }, envToDelete)
    const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(spawnEnv, command)
    // Why: SSH PTYs bypass main's host-env builder, so apply the guard after the relay merges its authoritative env.
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
    // Why: both renderer- and provider-delivered startup commands use this marker; the delivering side strips it from output.
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv, process.platform, {
      terminalWindowsWslDistro,
      emitReadyMarker: shouldEmitShellReadyMarker
    })

    if (context?.signal?.aborted || context?.isStale()) {
      // Why: cancellation remains side-effect-free until the exact native spawn seam.
      throw new Error('client_disconnected')
    }

    // Why: SSH exec channels give the relay a minimal environment without
    // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
    // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
    // When overlays are injected, the launch wrapper keeps those paths after
    // user startup files re-export their defaults.
    let term: IPty
    try {
      term = pty.spawn(shell, shellLaunch.args, {
        // Why: node-pty overwrites env.TERM with `name`; pass caller-selected TERM so it isn't lost.
        name: spawnEnv.TERM ?? 'xterm-256color',
        cols,
        rows,
        cwd,
        // Why: relay shells inherit process.env; don't let an ambient Orca marker enable shell-ready unless requested.
        env: { ...spawnEnv, ORCA_SHELL_READY_MARKER: '0', ...shellLaunch.env }
      })
    } catch (error) {
      // Why: Windows loads conpty.node only on first spawn, so handle that late binding failure here.
      if (isMissingNodePtyNativeBinding(error)) {
        this.invalidatePtyModuleAfterBindingFailure()
        throw new Error('node-pty is not available on this remote host')
      }
      throw error
    }
    onPhysicalSpawnCommitted?.()

    // Why: capture paneKey so the exit listener can evict per-pane caches without a separate ptyId→paneKey map.
    const tabId = typeof env?.ORCA_TAB_ID === 'string' ? env.ORCA_TAB_ID : undefined
    const attachIdentity = {
      paneKey: typeof params.paneKey === 'string' ? params.paneKey : paneKey,
      tabId: typeof params.tabId === 'string' ? params.tabId : tabId
    }
    const worktreeId = typeof env?.ORCA_WORKTREE_ID === 'string' ? env.ORCA_WORKTREE_ID : undefined
    const startupIngressIntent =
      params.startupIngressVersion === PTY_STARTUP_INGRESS_VERSION
        ? parsePtyStartupIngressIntent(params.startupIngress)
        : undefined
    const managed: ManagedPty = {
      id,
      incarnationId: randomUUID(),
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
      ownerBackend: resolvePtyOwnerBackend({
        platform: process.platform,
        shellPath: shell,
        wslDistro: terminalWindowsWslDistro
      }),
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
    if (context?.isStale() && !params.agentSessionEnsure && !params.agentSessionCreateOperationId) {
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
    return { id, incarnationId: managed.incarnationId }
  }

  private async attach(
    params: Record<string, unknown>
  ): Promise<{ incarnationId: string; replay?: string }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    // Why: after dispose, pty.kill is a POSIX no-op; treat disposed as not-found so failures aren't silent.
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }

    // Why: a shell can die without node-pty firing onExit (reaped out-of-band); prove liveness so attach doesn't strand a dead, lingering lease.
    if (managed.pty.pid && !isProcessAlive(managed.pty.pid)) {
      managed.physicalExit?.markExited()
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(id)
      this.notifyExitListener(managed)
      this.agentSessionOwners.release(managed.id)
      disposeManagedPty(managed)
      this.ptys.delete(id)
      this.clearPtyFlowState(id)
      throw new Error(`PTY "${id}" not found`)
    }

    // Why: a relay generation reset can reuse pty-N for a different pane; reject on identity disagreement (absent identity permissive).
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

    // Why: renderer hasn't registered replay handlers yet during spawn, so return to the caller instead of notifying too early.
    // Why: buffer intentionally NOT cleared after replay (client clears xterm first) so later restarts still replay full history.
    if (managed.buffered) {
      // Why: drop pending batched bytes already in the replay buffer so attach doesn't render them twice.
      this.pendingOutputByPty.delete(id)
      this.clearOutputFlushTimerIfIdle()
      if (params.suppressReplayNotification) {
        return { incarnationId: managed.incarnationId, replay: managed.buffered }
      }
      this.dispatcher.notify('pty.replay', { id, data: managed.buffered })
    }
    return { incarnationId: managed.incarnationId }
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

  private async getSize(
    params: Record<string, unknown>
  ): Promise<{ cols: number; rows: number } | null> {
    const managed = this.ptys.get(params.id as string)
    if (!managed || managed.disposed) {
      return null
    }
    return { cols: managed.pty.cols, rows: managed.pty.rows }
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
      // Why: remote Git deletion must not race the child's native handles; on timeout keep the map entry so onExit/retry still owns it.
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
    // Why: dispose neutralizes pty.kill on POSIX; treat disposed as not-found so signals don't silently no-op.
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
      // Why: ConPTY's bare kill is already force-final; block any later close of the handle.
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
    // Why: POSIX children may ignore SIGTERM; arm a bounded SIGKILL fallback.
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
        // Why: a transient SIGKILL failure must not strand an unreachable remote shell.
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
        incarnationId: managed.incarnationId,
        cwd: managed.initialCwd,
        title,
        ...(managed.worktreeId ? { worktreeId: managed.worktreeId } : {}),
        ...(managed.terminalHandle ? { terminalHandle: managed.terminalHandle } : {}),
        ...(this.agentSessionOwners.listForPty(id).length
          ? { agentSessionOwners: this.agentSessionOwners.listForPty(id) }
          : {})
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
    // Why: pane identity comes from the serialized entry (not env) since hook scripts exit without ORCA_PANE_KEY.
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
    // Why: serialized state may come from an older/untrusted client; reapply fresh-spawn bounds.
    const envToDelete = sanitizeEnvToDelete(entry.envToDelete)
    const shell = resolveDefaultShell()
    const spawnEnv = this.buildSpawnEnv(
      revivedEnv,
      { id: entry.id, paneKey: entry.paneKey, shell },
      envToDelete
    )
    // Why: revive lacks the original launch command, so reuse the fresh-spawn guard decision (legacy defaults to unguarded).
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
      incarnationId: randomUUID(),
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
      ownerBackend: resolvePtyOwnerBackend({
        platform: process.platform,
        shellPath: shell
      }),
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
    // Why: connected relays keep the configured grace so live PTYs survive restarts/reconnects.
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
    // Why: fence synchronously before the first await so a spawn/revive can't slip past disposal and escape exit.
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    this.agentSessionCreateOperations.clear()
    const disposePromise = this.disposePtys(options.waitForPhysicalExit !== false)
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Why: clear on rejected kill so a later shutdown can retry instead of joining a rejected promise.
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
    // Why: retain the native owner until SIGKILL is accepted (one bounded retry) or onExit proves it gone.
    await this.requestForceKillForRelayShutdown(managed)
    if (waitForPhysicalExit && this.ptys.get(managed.id) === managed && !managed.disposed) {
      try {
        await this.waitForPhysicalExit(managed, IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
      } catch {
        // An accepted SIGKILL is the final boundary when an uninterruptible child can't report exit.
      }
    }
    if (this.ptys.get(managed.id) === managed && !managed.disposed) {
      this.notifyExitListener(managed)
      this.agentSessionOwners.release(managed.id)
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
