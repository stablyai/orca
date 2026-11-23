// Writes a Claude permission mode, falling back where Claude refuses Full access or Approve for
// me, and records what Claude accepted or refused for its process.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeBypassRefusal, ClaudeSession } from '../claude-structured-session-state'
import {
  ClaudeControlRequestTimeoutError,
  isClaudeQueryClosed
} from '../../sdk-transport/claude-agent-sdk-control-requests'
import {
  claudeAllowedPermissionMode,
  claudeAutoFallbackReason,
  claudeAutoRetryDue,
  claudeBypassRefused,
  type ClaudeAutoUnsettled,
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

const CLAUDE_AUTO_REFUSAL = /Cannot set permission mode to auto/
const CLAUDE_AUTO_SETTINGS_REFUSAL = /auto mode disabled by settings/
const CLAUDE_AUTO_FOR_NOW_CODES = new Set([
  'auto_mode_model',
  'auto_mode_fast_mode',
  'auto_mode_circuit_breaker'
])

type ClaudeRefusal =
  | { kind: 'bypass'; reason: ClaudeBypassRefusal }
  | { kind: 'auto-settings' }
  | { kind: 'auto-for-now'; code: unknown }

function claudeRefusal(error: unknown, approveForMe: boolean): ClaudeRefusal | null {
  if (!(error instanceof Error)) {
    return null
  }
  const code = causeField(error, 'errorCode')
  for (const [reason, refusalCode, message] of CLAUDE_BYPASS_REFUSALS) {
    if (code === refusalCode || message.test(error.message)) {
      return { kind: 'bypass', reason }
    }
  }
  if (
    code === 'auto_mode_settings' ||
    (!approveForMe && CLAUDE_AUTO_SETTINGS_REFUSAL.test(error.message))
  ) {
    return { kind: 'auto-settings' }
  }
  const autoCode =
    typeof code === 'string' &&
    (approveForMe ? CLAUDE_AUTO_FOR_NOW_CODES.has(code) : code.startsWith('auto_mode'))
  return autoCode || (!approveForMe && CLAUDE_AUTO_REFUSAL.test(error.message))
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
  session.acknowledgedBuildPermissionMode = undefined
  session.askAcknowledgedAtReport = undefined
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
export function setClaudeAllowedPermissionMode(
  session: ClaudeSession,
  mode: PermissionMode,
  options?: { timeoutMs?: number }
): Promise<PermissionMode | undefined> {
  const request = claimClaudePermissionModeRequest(session)
  const pending = Promise.withResolvers<void>()
  session.pendingPermissionModeRequest = pending.promise
  return writeClaudePermissionMode(session, mode, options, request).finally(() => {
    if (session.pendingPermissionModeRequest === pending.promise) {
      session.pendingPermissionModeRequest = undefined
    }
    pending.resolve()
  })
}

async function writeClaudePermissionMode(
  session: ClaudeSession,
  mode: PermissionMode,
  options: { timeoutMs?: number } | undefined,
  request: number,
  refusedBefore?: ReadonlySet<PermissionMode>
): Promise<PermissionMode | undefined> {
  if (mode === 'plan') {
    await session.connection.setPermissionMode(mode, options)
    if (session.permissionModeRequests === request) {
      session.appliedInputOptions.set('interactionMode', mode)
      return mode
    }
    return undefined
  }
  const ladder = claudePermissionModeLadder(session, mode)
  const writes = await Promise.allSettled(
    ladder.map(async (step) => {
      await session.connection.setPermissionMode(step, options)
      if (
        step === 'default' &&
        session.launchIntent?.permissionMode === 'auto' &&
        session.permissionModeRequests === request
      ) {
        session.askAcknowledgedAtReport = session.reportedOptions.permissionModeReportSequence ?? 0
      }
    })
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
          session.autoUnansweredAskRequest = undefined
        }
        session.autoUnsettled = undefined
      }
      continue
    }
    const fallbackAuto = step === 'auto' && mode === 'bypassPermissions'
    const approveForMe = step === 'auto' && session.launchIntent?.permissionMode === 'auto'
    const unanswered = claudeLeftUnanswered(write.reason)
    // An answer Orca doesn't know refuses the fallback's auto for now; no answer leaves the mode
    // unknown, so the caller records no fallback and auto is asked again shortly.
    const refusal: ClaudeRefusal | null =
      claudeRefusal(write.reason, approveForMe) ??
      (fallbackAuto && !unanswered ? { kind: 'auto-for-now', code: undefined } : null)
    if (refusal === null || (refusal.kind === 'bypass') !== (step === 'bypassPermissions')) {
      unexpected = { error: write.reason, index }
      if (approveForMe && unanswered) {
        session.autoUnansweredAskRequest = request
        session.appliedInputOptions?.delete('buildPermissionMode')
        return writeClaudePermissionMode(session, 'default', options, request, refused)
      }
      if (fallbackAuto) {
        autoForNow = true
        session.autoUnsettled = { kind: 'time', retryAt: now + CLAUDE_AUTO_UNANSWERED_RETRY_MS }
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
    } else if (approveForMe) {
      session.autoRefusedForNow = true
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
  return writeClaudePermissionMode(session, mode, options, request, refused)
}

export function recordClaudeBuildPermissionMode(
  session: ClaudeSession,
  mode: PermissionMode
): void {
  if (
    claudeAutoFallbackReason(session) === null &&
    session.autoUnansweredAskRequest !== undefined &&
    session.autoUnansweredAskRequest === session.permissionModeRequests
  ) {
    return
  }
  session.acknowledgedBuildPermissionMode = mode
  session.appliedInputOptions.set('buildPermissionMode', mode)
  if (session.launchIntent?.permissionMode === 'auto' || mode === 'bypassPermissions') {
    journalClaudeSessionPermissionNotice(session)
  }
}
