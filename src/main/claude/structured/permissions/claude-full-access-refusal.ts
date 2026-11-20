// Claude runs a Full access launch in another mode when its settings turn bypass off
// (`permissions.disableBypassPermissionsMode`), and refuses any later switch to bypass.

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

export type ClaudeBypassFacts = Partial<
  Pick<
    ClaudeSession,
    | 'launchIntent'
    | 'firstRootInit'
    | 'bypassDisabled'
    | 'bypassRefusal'
    | 'autoDisabled'
    | 'autoUnsettled'
    | 'appliedInputOptions'
  >
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** Claude's merged settings, policy tiers included, as its `get_settings` reports them. */
export function readClaudeSettingsBypassDisabled(settings: unknown): boolean | undefined {
  const effective = record(record(settings)?.effective)
  return effective
    ? record(effective.permissions)?.disableBypassPermissionsMode === 'disable'
    : undefined
}

/** Claude's own setting, read at the top level or under `permissions` as Claude reads it. */
export function readClaudeSettingsAutoDisabled(settings: unknown): boolean | undefined {
  const effective = record(record(settings)?.effective)
  return effective
    ? effective.disableAutoMode === 'disable' ||
        record(effective.permissions)?.disableAutoMode === 'disable'
    : undefined
}

/** A first init in Plan proves nothing: a Plan start reports Plan whatever the settings say. */
export function claudeBypassRefused(session: ClaudeBypassFacts): boolean {
  if (session.launchIntent?.permissionMode !== 'bypassPermissions') {
    return false
  }
  const opened = session.firstRootInit?.permissionMode
  return (
    session.bypassDisabled ??
    (typeof opened === 'string' && opened !== 'bypassPermissions' && opened !== 'plan')
  )
}

/** Where Claude refuses Full access, Approve for me, or Ask where its settings turn that off too.
 *  Any other mode is asked for as chosen, so Claude's refusal of it fails the send. */
export function claudeAllowedPermissionMode(
  session: ClaudeBypassFacts,
  mode: PermissionMode
): PermissionMode {
  if (mode !== 'bypassPermissions' || !claudeBypassRefused(session)) {
    return mode
  }
  return session.autoDisabled === true ? 'default' : 'auto'
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
  const code = record(error.cause)?.errorCode
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

/** Whether asking for auto again can get a different answer than Claude's last refusal. */
export function claudeAutoRetryDue(session: ClaudeBypassFacts, now = Date.now()): boolean {
  const unsettled = session.autoUnsettled
  const options = session.appliedInputOptions
  switch (unsettled?.kind) {
    case undefined:
      return false
    case 'model':
      return options?.get('model') !== unsettled.model
    case 'fast-mode':
      return options?.get('fastMode') !== unsettled.fastMode
    case 'time':
      return now >= unsettled.retryAt
  }
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
    return [mode]
  }
  const bypassKnown =
    session.bypassDisabled !== undefined ||
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
  refusedBefore: ReadonlySet<PermissionMode> = new Set()
): Promise<PermissionMode> {
  const ladder = claudePermissionModeLadder(session, mode)
  const writes = await Promise.allSettled(
    ladder.map((step) => session.connection.setPermissionMode(step, options))
  )
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
        session.bypassRefusal = undefined
      } else if (step === 'auto') {
        session.autoDisabled = false
        session.autoUnsettled = undefined
      }
      continue
    }
    const fallbackAuto = step === 'auto' && mode === 'bypassPermissions'
    // An answer Orca doesn't know refuses the fallback's auto for now; no answer leaves the mode
    // unknown, so nothing is recorded and the next send asks again.
    const answered =
      !(write.reason instanceof ClaudeControlRequestTimeoutError) &&
      !isClaudeQueryClosed(write.reason)
    const refusal: ClaudeRefusal | null =
      claudeRefusal(write.reason) ??
      (fallbackAuto && answered ? { kind: 'auto-for-now', code: undefined } : null)
    if (refusal === null || (refusal.kind === 'bypass') !== (step === 'bypassPermissions')) {
      unexpected = { error: write.reason, index }
      if (fallbackAuto) {
        autoForNow = true
        session.autoUnsettled = { kind: 'time', retryAt: now }
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
    throw unexpected.error
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
  return setClaudeAllowedPermissionMode(session, mode, options, refused)
}

type ClaudeModeFacts = Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'> &
  Partial<Pick<ClaudeSession, 'orderedPermissionMode'>>

/** Plan as chosen or as Claude runs it, in wire order where known. */
export function claudeInPlan(session: ClaudeModeFacts): boolean {
  const running = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  return session.appliedInputOptions.get('interactionMode') === 'plan' || running === 'plan'
}

/** A refused Full access chat outside Plan whose fallback no build switch has applied yet, or
 *  whose Approve for me Claude refused for a reason that may have passed. */
export function claudeOwesFullAccessFallback(
  session: ClaudeBypassFacts & ClaudeModeFacts
): boolean {
  return (
    claudeBypassRefused(session) &&
    (!session.appliedInputOptions.has('buildPermissionMode') || claudeAutoRetryDue(session)) &&
    !claudeInPlan(session)
  )
}
