import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeTerminalRowMetadata } from '../../shared/runtime-terminal-contracts'
import { IMMEDIATE_KILL_REPLY_BUDGET_MS } from '../daemon/immediate-kill-reply-budget'
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
import type { RuntimeSkillCommandSurface } from './runtime-skill-command-contract'

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

// Allow lost-response reconnect retries for one minute; later intentional resumes fork fresh.
export const MOBILE_TERMINAL_CREATE_RESULT_TTL_MS = 60_000

// Connection-migration retries reuse clientMutationId to avoid duplicate workspaces.
export const WORKTREE_CREATE_RESULT_TTL_MS = 60_000

export const MOBILE_TERMINAL_SURFACE_TIMEOUT_MS = 10_000

// Rejected splits need only a quick teardown verdict before fallback kill; unreachable hosts must not stall rejection.
export const REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS = 2_000

// Include immediate-kill and follow-up inventory budgets; agent exit hooks can delay verification.
export const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = IMMEDIATE_KILL_REPLY_BUDGET_MS + 2_000

export const CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000

export const CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS = 1500

// Claude shows its cursor before composer rendering settles.
export const CLAUDE_AGENT_PROMPT_RENDER_MARKER = '\x1b[?25h'

export const MOBILE_TERMINAL_READY_FALLBACK_MS = 1000

export const SSH_PANE_RECOVERY_GRACE_MS = 30_000

// Cache proven absence across keystroke bursts, but let recreated session ids recover promptly.
export const PROVEN_ABSENT_LEAF_PTY_TTL_MS = 15_000

export const TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS = 2_000

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
  tailRows?: RuntimeTerminalRowMetadata[]
}

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

// Absence means default; surfacing callers must omit surfaceOwner instead of sending true.
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

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

export type RuntimeWorktreeLifecycleEvent =
  | { kind: 'created'; worktreeId: string; path: string; branch: string }
  | { kind: 'removed'; worktreeId: string; path: string }

// One driver per PTY: idle has no subscriber; desktop has passive/reclaimed subscribers.
// mobile owns input/resize and blocks desktop writes; see docs/mobile-presence-lock.md.
export type DriverState = RuntimeTerminalDriverState

// Desktop uses renderer geometry while phones watch passively; phone uses its owner viewport and suppresses desktop fit.
// See docs/mobile-terminal-layout-state-machine.md.
export type PtyLayoutTarget =
  | { kind: 'desktop'; cols: number; rows: number }
  | { kind: 'phone'; cols: number; rows: number; ownerClientId: string }
  | { kind: 'remote-desktop'; cols: number; rows: number; ownerSubscriptionKey: string }

// Increment on successful layout changes so clients reject stale transitions.
export type PtyLayoutState = PtyLayoutTarget & {
  seq: number
  appliedAt: number
}

// Only successful changes own a new seq; pty-exited is terminal, resize-failed retryable.
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
