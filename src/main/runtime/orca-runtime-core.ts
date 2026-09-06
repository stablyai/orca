// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { isCursorAgentTitle } from '../../shared/agent-detection'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  RuntimeTerminalDriverState,
  RuntimeTerminalPresentation
} from '../../shared/runtime-types'
import type { RuntimeEdgeCommandSurface } from './runtime-edge-command-controller'
import type { RuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import type { RuntimeFileCommandSurface } from './runtime-file-command-surface'
import type { RuntimeGitCommandSurface } from './runtime-git-command-surface'
import type { RuntimeRepositoryCommandSurface } from './runtime-repository-command-surface'
import type { RuntimeReviewCommandSurface } from './runtime-review-command-surface'
import type { RuntimeServiceCommandSurface } from './runtime-service-command-surface'
import type { RuntimeSkillCommandSurface } from './runtime-skill-command-surface'

export type PtyIncarnationHandleRecord = {
  handle: string
  incarnationId: string | null
  leafKey: string
}

export type RuntimeWorktreeScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanResult
  expiresAt: number
  adminFingerprint: string | null
  scannedAt: number
}

export type RuntimeWorktreeScanInFlight = {
  generation: number
  runtimeKey: string
  promise: Promise<RuntimeWorktreeScanRefresh>
}

export type RuntimeWorktreeScanRefresh = {
  result: RuntimeWorktreeScanResult
  adminFingerprint: string | null
  adminFingerprintProbe: Promise<string | null> | null
  scannedAt: number
}

export type ResolvedTerminalWorkspaceLaunchTarget = {
  scope: TerminalWorkspaceLaunchScope
  managedWorktree: ResolvedWorktree | null
}

export function isCursorAgentOrchestrationTarget(
  leaf: RuntimeLeafRecord,
  tabTitle: string | null | undefined
): boolean {
  return [leaf.lastOscTitle, leaf.paneTitle, tabTitle].some(isCursorAgentTitle)
}

export const AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT = 512

export const AGENT_SESSION_OPERATION_GLOBAL_LIMIT = 4_096

// Why: long enough for a phone to reconnect and retry a create whose response
// was lost, short enough that an intentional later re-resume forks fresh.
export const MOBILE_TERMINAL_CREATE_RESULT_TTL_MS = 60_000

// Why: same idempotency window for worktree.create — a phone whose create was
// interrupted by a connection migration retries with the same clientMutationId
// and reuses the just-created worktree instead of spawning a duplicate.
export const WORKTREE_CREATE_RESULT_TTL_MS = 60_000

export const MOBILE_TERMINAL_SURFACE_TIMEOUT_MS = 10_000

// Why: the split already failed; the caller waits on this teardown only to learn whether the
// fallback kill is needed, so keep it short — an unreachable host must not stall the rejection.
export const REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS = 2_000

export const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = 2_000

export const CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000

export const CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS = 1500

// Why: Claude emits show-cursor while rendering its composer; output must settle afterward.
export const CLAUDE_AGENT_PROMPT_RENDER_MARKER = '\x1b[?25h'

export const MOBILE_TERMINAL_READY_FALLBACK_MS = 1000

export const SSH_PANE_RECOVERY_GRACE_MS = 30_000

// Why: long enough that a keystroke burst to a proven-dead leaf probes once,
// short enough that a recreated session id regains writability quickly even if
// its runtime record (which also invalidates the verdict) is late.
export const PROVEN_ABSENT_LEAF_PTY_TTL_MS = 15_000

export const TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS = 2_000

export type RuntimeTerminalProjection = { lines: string[]; draft?: string }

export function assertAgentPromptRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
}

export async function waitForAgentPromptPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return await promise
  }
  assertAgentPromptRequestActive(signal)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if ('error' in result) {
        reject(result.error)
      } else {
        resolve(result.value)
      }
    }
    const onAbort = (): void => finish({ error: new Error('request_aborted') })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    )
  })
}

// Generic terminal.send uses setImmediate to let abort/permission/data callbacks run between
// chunks without paying a full Windows timer tick for every 16 KiB write. Agent prompts use an
// atomic bracketed-paste write, so they do not rely on this scheduler.
// Why the global and not node:timers/promises: only the global is intercepted by fake timers,
// so a chunked paste stays observable on the test clock.
export function yieldBetweenTerminalInputChunks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

export async function waitForAgentPromptDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  assertAgentPromptRequestActive(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}

export function findLastCompleteOscTitleRange(data: string): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null
  let searchFrom = 0
  while (searchFrom < data.length) {
    const start = data.indexOf('\x1b]', searchFrom)
    if (start === -1) {
      break
    }
    const command = data[start + 2]
    if ((command !== '0' && command !== '1' && command !== '2') || data[start + 3] !== ';') {
      searchFrom = start + 2
      continue
    }
    let cursor = start + 4
    for (; cursor < data.length; cursor += 1) {
      if (data[cursor] === '\x07') {
        last = { start, end: cursor + 1 }
        searchFrom = cursor + 1
        break
      }
      if (data[cursor] !== '\x1b') {
        continue
      }
      if (data[cursor + 1] === '\\') {
        last = { start, end: cursor + 2 }
        searchFrom = cursor + 2
      } else {
        searchFrom = cursor
      }
      break
    }
    if (cursor === data.length) {
      break
    }
  }
  return last
}

export function isClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'client_disconnected'
}

export function createTerminalRevealWarning(handle: string, error?: unknown): string {
  const reason =
    error instanceof Error && error.message.trim().length > 0
      ? ` Reason: ${error.message.trim()}.`
      : ''
  return [
    `Terminal ${handle} is running, but Orca could not make it discoverable.${reason}`,
    `Run \`orca terminal focus --terminal ${handle}\` to reveal and focus it.`
  ].join(' ')
}

// Why: an absent `surfaceOwner` means "default", so surfacing callers must omit
// the key rather than send `true`.
export function ownerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}

export function resolveTerminalPresentation(opts: {
  presentation?: RuntimeTerminalPresentation
  focus?: boolean
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (opts.presentation) {
    return opts.presentation
  }
  if (opts.focus === true || opts.activate === true) {
    return 'focused'
  }
  return undefined
}

// Subscribe a listener to a per-key Set, pruning the key's entry once its last
// listener unsubscribes. Returns the unsubscribe callback.
export function addListenerToMap<T>(
  map: Map<string, Set<T>>,
  key: string,
  listener: T
): () => void {
  let listeners = map.get(key)
  if (!listeners) {
    listeners = new Set<T>()
    map.set(key, listeners)
  }
  const set = listeners
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      map.delete(key)
    }
  }
}

export function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

// Why: notificationSeq is the desktop-assigned monotonic sequence used for
// mobile reconnect catch-up (#8129). It is added on dispatch (and replay) so a
// client can watermark the last event it delivered and request exactly the
// events after it — idempotent, no duplicate local pushes.
export type RuntimeWorktreeLifecycleEvent =
  | { kind: 'created'; worktreeId: string; path: string; branch: string }
  | { kind: 'removed'; worktreeId: string; path: string }

// Why: presence-based driver state for the mobile-presence lock. Exactly one
// driver per PTY at any moment. See docs/mobile-presence-lock.md.
//   - `idle`: no mobile subscribers; desktop input flows freely
//   - `desktop`: at least one mobile client subscribed but desktop reclaimed
//      (or all mobile clients are passive `desktop`-mode watchers); desktop
//      input flows freely
//   - `mobile{clientId}`: a mobile client is the active driver; desktop
//      input/resize are dropped server-side and the lock banner is mounted.
//      `clientId` is the most recent mobile actor for this PTY.
export type DriverState = RuntimeTerminalDriverState

// Why: per-PTY layout target — what the PTY *should* be at right now.
// `desktop` ⇒ runs at the desktop renderer's pane geometry; mobile passive
// watchers (mode='desktop') still receive scrollback. `phone` ⇒ runs at
// `ownerClientId`'s viewport; the desktop renderer's auto-fit is suppressed.
// See docs/mobile-terminal-layout-state-machine.md.
export type PtyLayoutTarget =
  | { kind: 'desktop'; cols: number; rows: number }
  | { kind: 'phone'; cols: number; rows: number; ownerClientId: string }
  | { kind: 'remote-desktop'; cols: number; rows: number; ownerSubscriptionKey: string }

// Why: authoritative layout state with monotonic seq. Bumped on every
// applyLayout success; emitted on mobile subscribe-stream events so clients
// drop stale events that arrive after a newer transition.
export type PtyLayoutState = PtyLayoutTarget & {
  seq: number
  appliedAt: number
}

// Why: applyLayout result discriminator. Callers (especially RPC handlers)
// need to distinguish "shipped a new state at seq N" from "no-op — caller
// should not claim a seq it didn't produce." `pty-exited` is terminal;
// `resize-failed` is transient and the caller may retry.
export type ApplyLayoutResult =
  | { ok: true; state: PtyLayoutState }
  | { ok: false; reason: 'pty-exited' | 'resize-failed' }

export type LayoutQueueEntry = {
  running: Promise<ApplyLayoutResult> | null
  pending: {
    target: PtyLayoutTarget
    waiters: ((r: ApplyLayoutResult) => void)[]
  }[]
}

export type RuntimeInstalledCommandSurfaces = RuntimeEdgeCommandSurface &
  RuntimeLinearCommandSurface &
  RuntimeFileCommandSurface &
  RuntimeGitCommandSurface &
  RuntimeRepositoryCommandSurface &
  RuntimeReviewCommandSurface &
  RuntimeServiceCommandSurface &
  RuntimeSkillCommandSurface

export type RuntimeCommandSurfaceHost<T> = T & RuntimeInstalledCommandSurfaces

export type RuntimeRendererReloadFence = Readonly<{
  revision: number
  recovery: 'renderer' | 'headless' | 'reloading'
}>
