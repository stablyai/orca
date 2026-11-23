// Writes a Claude permission mode, falling back where Claude refuses Full access or Approve for
// me, and records what Claude accepted or refused for its process.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeAutoUnsettled,
  ClaudeBypassRefusal,
  ClaudeSession
} from '../claude-structured-session-state'
import {
  ClaudeControlRequestTimeoutError,
  isClaudeQueryClosed
} from '../../sdk-transport/claude-agent-sdk-control-requests'
import {
  claudeAllowedPermissionMode,
  claudeAutoFallbackReason,
  claudeAutoRetryDue,
  claudeBypassRefused,
  claudeOwesPermissionFallback,
  type ClaudeBypassFacts
} from './claude-full-access-refusal'
import { journalClaudeSessionPermissionNotice } from './claude-full-access-refusal-notice'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function causeField(error: unknown, field: string): unknown {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return isRecord(cause) ? cause[field] : undefined
}

/** A timeout, a closed query or a transport failure: the request may never have reached Claude. */
function claudeLeftUnanswered(error: unknown): boolean {
  return (
    error instanceof ClaudeControlRequestTimeoutError ||
    isClaudeQueryClosed(error) ||
    typeof causeField(error, 'errorClass') === 'string'
  )
}

// Claude's answers to `set_permission_mode bypassPermissions` it can't apply.
const CLAUDE_BYPASS_REFUSALS: readonly [ClaudeBypassRefusal, string, RegExp][] = [
  ['settings', 'bypass_disabled', /bypassPermissions because it is disabled by settings/],
  ['restricted', 'bypass_restricted', /bypassPermissions not supported in restricted mode/],
  ['not-launched', 'bypass_not_launched', /session was not launched with --dangerously-skip/]
]

// Claude refuses auto for its settings (lasting), or for availability, the model, Fast mode or
// its circuit breaker (which can change, so a later send asks again).
const CLAUDE_AUTO_REFUSAL = /Cannot set permission mode to auto/
const CLAUDE_AUTO_SETTINGS_REFUSAL = /auto mode disabled by settings/

type ClaudeRefusal =
  | { kind: 'bypass'; reason: ClaudeBypassRefusal }
  | { kind: 'auto-settings' }
  | { kind: 'auto-for-now'; code: unknown }

function claudeRefusal(error: unknown): ClaudeRefusal | null {
  if (!(error instanceof Error)) {
    return null
  }
  const code = causeField(error, 'errorCode')
  for (const [reason, refusalCode, message] of CLAUDE_BYPASS_REFUSALS) {
    if (code === refusalCode || message.test(error.message)) {
      return { kind: 'bypass', reason }
    }
  }
  if (code === 'auto_mode_settings' || CLAUDE_AUTO_SETTINGS_REFUSAL.test(error.message)) {
    return { kind: 'auto-settings' }
  }
  return (typeof code === 'string' && code.startsWith('auto_mode')) ||
    CLAUDE_AUTO_REFUSAL.test(error.message)
    ? { kind: 'auto-for-now', code }
    : null
}

// Availability and the circuit breaker pass with time; asking sooner only repeats the refusal.
const CLAUDE_AUTO_RETRY_MS = 60_000
// An unanswered switch is asked again soon, without making every input wait on it.
const CLAUDE_AUTO_UNANSWERED_RETRY_MS = 10_000

function claudeAutoUnsettled(
  session: ClaudeBypassFacts,
  code: unknown,
  now: number
): ClaudeAutoUnsettled {
  const options = session.appliedInputOptions
  return code === 'auto_mode_model'
    ? { kind: 'model', model: options?.get('model') }
    : code === 'auto_mode_fast_mode'
      ? { kind: 'fast-mode', fastMode: options?.get('fastMode') }
      : { kind: 'time', retryAt: now + CLAUDE_AUTO_RETRY_MS }
}

/** The modes to write in order, the last one Claude accepts winning (Claude answers them in the
 *  order sent): a step whose answer is unknown goes out right behind its fallback, and the
 *  fallback always opens with Ask, so a refusal never needs a late write that could land after a
 *  newer choice. */
function claudePermissionModeLadder(
  session: ClaudeBypassFacts,
  mode: PermissionMode
): PermissionMode[] {
  if (mode !== 'bypassPermissions') {
    return [claudeAllowedPermissionMode(session, mode)]
  }
  const bypassKnown =
    session.bypassDisabled !== undefined ||
    session.bypassAccepted === true ||
    session.firstRootInit?.permissionMode === 'bypassPermissions' ||
    claudeBypassRefused(session)
  if (bypassKnown && !claudeBypassRefused(session)) {
    return ['bypassPermissions']
  }
  const fallback: PermissionMode[] =
    session.autoDisabled === true ||
    (session.autoUnsettled !== undefined && !claudeAutoRetryDue(session))
      ? ['default']
      : ['default', 'auto']
  return bypassKnown ? fallback : [...fallback, 'bypassPermissions']
}

/** Marks a new permission mode request; a pending fallback for an older one no longer writes. */
export function claimClaudePermissionModeRequest(session: ClaudeBypassFacts): number {
  session.permissionModeRequests = (session.permissionModeRequests ?? 0) + 1
  return session.permissionModeRequests
}

/** A switch that went unanswered after Claude accepted an earlier step: Claude runs `accepted`
 *  or a later step, so it has left any mode before the request. */
export class ClaudePermissionModeUnsettled extends Error {
  constructor(
    readonly accepted: PermissionMode,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ClaudePermissionModeUnsettled'
  }
}

/** Asks for the mode Claude allows and resolves to the mode applied, remembering what Claude
 *  accepted or refused for this process. Claude rereads its settings, so bypass or auto it
 *  allowed earlier can be refused later; that refusal is followed by the fallback, and a
 *  refusal with no fallback left is the caller's error. */
export async function setClaudeAllowedPermissionMode(
  session: ClaudeBypassFacts & {
    connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
  },
  mode: PermissionMode,
  options?: { timeoutMs?: number },
  refusedBefore: ReadonlySet<PermissionMode> = new Set(),
  request = claimClaudePermissionModeRequest(session)
): Promise<PermissionMode | undefined> {
  const ladder = claudePermissionModeLadder(session, mode)
  const writes = await Promise.allSettled(
    ladder.map((step) => session.connection.setPermissionMode(step, options))
  )
  if (session.permissionModeRequests !== request) {
    return
  }
  const now = Date.now()
  let applied: PermissionMode | null = null
  let appliedIndex = -1
  let lastRefusal: unknown = null
  let unexpected: { error: unknown; index: number } | null = null
  let autoForNow = false
  const refused = new Set(refusedBefore)
  // Every answer is recorded before any error is rethrown, so later steps' facts survive.
  for (const [index, write] of writes.entries()) {
    const step = ladder[index]
    if (write.status === 'fulfilled') {
      applied = step
      appliedIndex = index
      lastRefusal = null
      if (step === 'bypassPermissions') {
        session.bypassDisabled = false
        session.bypassAccepted = true
        session.bypassRefusal = undefined
      } else if (step === 'auto') {
        session.autoDisabled = false
        if (session.launchIntent?.permissionMode === 'auto') {
          session.autoAccepted = true
        }
        session.autoUnsettled = undefined
      }
      continue
    }
    const fallbackAuto = step === 'auto' && mode === 'bypassPermissions'
    const unanswered = claudeLeftUnanswered(write.reason)
    // An answer Orca doesn't know refuses the fallback's auto for now; no answer leaves the mode
    // unknown, so the caller records no fallback and auto is asked again shortly.
    const refusal: ClaudeRefusal | null =
      claudeRefusal(write.reason) ??
      (fallbackAuto && !unanswered ? { kind: 'auto-for-now', code: undefined } : null)
    if (refusal === null || (refusal.kind === 'bypass') !== (step === 'bypassPermissions')) {
      unexpected = { error: write.reason, index }
      if (fallbackAuto || (step === 'auto' && refusal === null && unanswered)) {
        autoForNow = true
        session.autoUnsettled = { kind: 'time', retryAt: now + CLAUDE_AUTO_UNANSWERED_RETRY_MS }
        if (!fallbackAuto) {
          return setClaudeAllowedPermissionMode(session, 'default', options, refused, request)
        }
      }
      continue
    }
    lastRefusal = write.reason
    refused.add(step)
    if (refusal.kind === 'bypass') {
      session.bypassDisabled = true
      session.bypassRefusal = refusal.reason
    } else if (refusal.kind === 'auto-settings') {
      session.autoDisabled = true
      session.autoUnsettled = undefined
    } else {
      autoForNow = true
      session.autoUnsettled = claudeAutoUnsettled(session, refusal.code, now)
    }
  }
  // A mode Claude accepted after a failed write is the one it runs, so only a failure after the
  // last acceptance leaves the outcome unknown.
  if (unexpected && unexpected.index > appliedIndex) {
    throw applied === null
      ? unexpected.error
      : new ClaudePermissionModeUnsettled(applied, unexpected.error)
  }
  // Auto refused for a reason that can pass: whatever Claude accepted stands for now, and the
  // fallback stays owed so a later send asks for auto again once that can change the answer.
  if (applied !== null && (lastRefusal === null || autoForNow)) {
    return applied
  }
  const next = claudeAllowedPermissionMode(session, mode)
  if (applied === next) {
    return applied
  }
  if (refused.has(next) || refused.size > 2) {
    throw lastRefusal
  }
  // Only a refusal of a mode allowed earlier gets here; each one is a new fact.
  return setClaudeAllowedPermissionMode(session, mode, options, refused, request)
}

export function recordClaudeBuildPermissionMode(
  session: ClaudeSession,
  mode: PermissionMode
): void {
  session.appliedInputOptions.set('buildPermissionMode', mode)
  if (session.launchIntent?.permissionMode === 'auto' || mode === 'bypassPermissions') {
    journalClaudeSessionPermissionNotice(session)
  }
}

export function observeClaudeRootInit(
  session: ClaudeSession | null,
  firstRootInit: ClaudeSession['firstRootInit']
): void {
  if (!session) {
    return
  }
  const previous = session.firstRootInit
  session.firstRootInit ??= firstRootInit
  if (session.launchIntent?.permissionMode === 'auto') {
    const opened = firstRootInit?.permissionMode
    if (
      !previous &&
      typeof opened === 'string' &&
      opened !== 'auto' &&
      opened !== 'plan' &&
      claudeAutoFallbackReason(session) !== null &&
      !session.appliedInputOptions.has('buildPermissionMode')
    ) {
      if (opened === 'default') {
        session.appliedInputOptions.set('buildPermissionMode', 'default')
        return
      }
      const write = setClaudeAllowedPermissionMode(session, 'default')
      const request = session.permissionModeRequests
      void write.then(
        (mode) => {
          if (mode !== undefined && session.permissionModeRequests === request) {
            recordClaudeBuildPermissionMode(session, mode)
          }
        },
        () => {}
      )
    }
    return
  }
  if (!claudeBypassRefused(session) || !claudeOwesPermissionFallback(session)) {
    return
  }
  const write = setClaudeAllowedPermissionMode(session, 'bypassPermissions')
  const request = session.permissionModeRequests
  void write.then(
    (mode) => {
      if (mode !== undefined && session.permissionModeRequests === request) {
        session.appliedInputOptions.set('buildPermissionMode', mode)
      }
    },
    () => {
      if (session.permissionModeRequests === request) {
        session.appliedInputOptions.delete('buildPermissionMode')
      }
    }
  )
}

/** Auto launches read the first init only once the session is published. */
export function adoptClaudeLaunchRootInit(
  session: ClaudeSession,
  firstRootInit: ClaudeSession['firstRootInit']
): () => void {
  if (session.launchIntent?.permissionMode === 'auto') {
    return () => observeClaudeRootInit(session, firstRootInit)
  }
  session.firstRootInit = firstRootInit
  return () => {}
}
