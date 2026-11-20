// Claude runs a Full access launch in another mode when its settings turn bypass off
// (`permissions.disableBypassPermissionsMode`), and refuses any later switch to bypass.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'
import {
  ClaudeControlRequestTimeoutError,
  isClaudeQueryClosed
} from '../../sdk-transport/claude-agent-sdk-control-requests'

type ClaudeBypassFacts = Partial<
  Pick<
    ClaudeSession,
    'launchIntent' | 'firstRootInit' | 'bypassDisabled' | 'autoDisabled' | 'autoUnsettled'
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
function claudeAllowedPermissionMode(
  session: ClaudeBypassFacts,
  mode: PermissionMode
): PermissionMode {
  if (mode !== 'bypassPermissions' || !claudeBypassRefused(session)) {
    return mode
  }
  return session.autoDisabled === true ? 'default' : 'auto'
}

// Claude's answer to `set_permission_mode bypassPermissions` once its settings turn bypass off.
const CLAUDE_BYPASS_REFUSAL = /bypassPermissions because it is disabled by settings/

// Claude refuses auto for its settings (lasting), or for availability, the model or Fast mode
// (which can change, so the next send asks again).
const CLAUDE_AUTO_REFUSAL = /Cannot set permission mode to auto/
const CLAUDE_AUTO_SETTINGS_REFUSAL = /auto mode disabled by settings/

type ClaudeRefusal = 'bypass' | 'auto-settings' | 'auto-for-now'

function claudeRefusal(error: unknown): ClaudeRefusal | null {
  if (!(error instanceof Error)) {
    return null
  }
  const code = record(error.cause)?.errorCode
  if (code === 'bypass_disabled' || CLAUDE_BYPASS_REFUSAL.test(error.message)) {
    return 'bypass'
  }
  if (code === 'auto_mode_settings' || CLAUDE_AUTO_SETTINGS_REFUSAL.test(error.message)) {
    return 'auto-settings'
  }
  return (typeof code === 'string' && code.startsWith('auto_mode')) ||
    CLAUDE_AUTO_REFUSAL.test(error.message)
    ? 'auto-for-now'
    : null
}

/** The modes to write in order, the last one Claude accepts winning: a step whose answer is
 *  unknown goes out right behind its fallback, so a refusal never needs a late write that
 *  could land after a newer choice. */
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
    session.autoDisabled === true
      ? ['default']
      : session.autoDisabled === false && session.autoUnsettled !== true
        ? ['auto']
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
  let applied: PermissionMode | null = null
  let lastRefusal: unknown = null
  let unexpected: { error: unknown } | null = null
  let autoForNow = false
  const refused = new Set(refusedBefore)
  // Every answer is recorded before any error is rethrown, so later steps' facts survive.
  for (const [index, write] of writes.entries()) {
    const step = ladder[index]
    if (write.status === 'fulfilled') {
      applied = step
      lastRefusal = null
      if (step === 'bypassPermissions') {
        session.bypassDisabled = false
      } else if (step === 'auto') {
        session.autoDisabled = false
      }
      continue
    }
    const fallbackAuto = step === 'auto' && mode === 'bypassPermissions'
    // An answer Orca doesn't know refuses the fallback's auto for now; no answer leaves the mode
    // unknown, so nothing is recorded and a later send asks again.
    const answered =
      !(write.reason instanceof ClaudeControlRequestTimeoutError) &&
      !isClaudeQueryClosed(write.reason)
    const refusal =
      claudeRefusal(write.reason) ?? (fallbackAuto && answered ? 'auto-for-now' : null)
    if (refusal === null || (refusal === 'bypass') !== (step === 'bypassPermissions')) {
      unexpected ??= { error: write.reason }
      autoForNow ||= fallbackAuto
      continue
    }
    lastRefusal = write.reason
    refused.add(step)
    if (refusal === 'bypass') {
      session.bypassDisabled = true
    } else if (refusal === 'auto-settings') {
      session.autoDisabled = true
    } else {
      autoForNow = true
    }
  }
  // Auto refused for a reason that can pass: whatever Claude accepted stands for now, and the
  // fallback stays owed so a later send asks for auto again.
  session.autoUnsettled = autoForNow
  if (unexpected) {
    throw unexpected.error
  }
  if (applied !== null && (lastRefusal === null || autoForNow)) {
    return applied
  }
  if (autoForNow && applied === null && mode === 'bypassPermissions') {
    // The fallback's auto that worked earlier is refused for now: Ask until a later send asks again.
    await session.connection.setPermissionMode('default', options)
    return 'default'
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

/** A refused Full access chat outside Plan whose fallback no build switch has applied yet. */
export function claudeOwesFullAccessFallback(
  session: ClaudeBypassFacts & ClaudeModeFacts
): boolean {
  return (
    claudeBypassRefused(session) &&
    (!session.appliedInputOptions.has('buildPermissionMode') || session.autoUnsettled === true) &&
    !claudeInPlan(session)
  )
}

/** The warning waits for a first fallback attempt, Plan exit included, so it names a mode
 *  Claude accepted. */
export function claudeFullAccessRefusalNoticeDue(
  session: ClaudeBypassFacts & Pick<ClaudeSession, 'appliedInputOptions'>
): boolean {
  return claudeBypassRefused(session) && session.appliedInputOptions.has('buildPermissionMode')
}

const MAX_ANNOUNCED = 1_000
const announced = new Set<string>()

/** Once per chat while Orca runs: each restart of a refused chat opens the same way. */
export function claimClaudeFullAccessRefusalNotice(sessionId: string): boolean {
  if (announced.has(sessionId)) {
    return false
  }
  announced.add(sessionId)
  if (announced.size > MAX_ANNOUNCED) {
    const oldest = announced.values().next().value
    if (oldest !== undefined) {
      announced.delete(oldest)
    }
  }
  return true
}

/** Names the mode Claude runs instead: the fallback applied, else what Claude reports, else
 *  the fallback the next build switch will ask for. */
export function claudeFullAccessRefusalRow(
  session: ClaudeBypassFacts &
    Partial<Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'>>
): AgentJournalStatusItem {
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  const reported = session.reportedOptions?.reportedPermissionMode
  const choice =
    applied !== undefined
      ? readClaudeReportedPermissionMode({
          type: 'system',
          subtype: 'init',
          permissionMode: applied
        })
      : reported && reported !== 'plan' && reported !== 'full-access'
        ? reported
        : readClaudeReportedPermissionMode({
            type: 'system',
            subtype: 'init',
            permissionMode: claudeAllowedPermissionMode(session, 'bypassPermissions')
          })
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
  return {
    kind: 'status',
    tone: 'warning',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text:
      choice === 'ask' && session.autoDisabled === true
        ? `Claude's settings turn off Full access and Approve for me (permissions.disableBypassPermissionsMode, disableAutoMode), so Claude uses ${running} instead.`
        : choice === 'ask' && session.autoUnsettled === true
          ? `Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses ${running} instead.`
          : `Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses ${running} instead.`
  }
}

/** One warning row on the first root frame after Claude's fallback is applied. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  idPrefix: string,
  turnScope: AgentJournalTurnScope
): void {
  const body = deps.fullAccessRefusalNotice?.()
  if (!body) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `full-access-refused:claude:${idPrefix}` },
    body,
    { turnScope }
  )
  deps.sink.publish()
}
