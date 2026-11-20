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

type ClaudeBypassFacts = Partial<
  Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'bypassDisabled' | 'autoDisabled'>
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

/** Where Claude refuses bypass, Approve for me, or Ask where its settings turn that off too. */
export function claudeAllowedPermissionMode(
  session: ClaudeBypassFacts,
  mode: PermissionMode
): PermissionMode {
  const wanted = mode === 'bypassPermissions' && claudeBypassRefused(session) ? 'auto' : mode
  return wanted === 'auto' && session.autoDisabled === true ? 'default' : wanted
}

// Claude's answer to `set_permission_mode bypassPermissions` once its settings turn bypass off.
const CLAUDE_BYPASS_REFUSAL = /bypassPermissions because it is disabled by settings/

// Claude's answer to `set_permission_mode auto` once its settings turn auto mode off.
const CLAUDE_AUTO_REFUSAL = /Cannot set permission mode to auto/

function claudeRefusal(error: unknown): 'bypass' | 'auto' | null {
  if (!(error instanceof Error)) {
    return null
  }
  const code = record(error.cause)?.errorCode
  if (code === 'bypass_disabled' || CLAUDE_BYPASS_REFUSAL.test(error.message)) {
    return 'bypass'
  }
  return (typeof code === 'string' && code.startsWith('auto_mode')) ||
    CLAUDE_AUTO_REFUSAL.test(error.message)
    ? 'auto'
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
    return [claudeAllowedPermissionMode(session, mode)]
  }
  const bypassKnown =
    session.bypassDisabled !== undefined ||
    session.firstRootInit?.permissionMode === 'bypassPermissions' ||
    claudeBypassRefused(session)
  if (bypassKnown && !claudeBypassRefused(session)) {
    return ['bypassPermissions']
  }
  const fallback: PermissionMode[] =
    session.autoDisabled === undefined
      ? ['default', 'auto']
      : [session.autoDisabled ? 'default' : 'auto']
  return bypassKnown ? fallback : [...fallback, 'bypassPermissions']
}

/** Asks for the mode Claude allows and resolves to the mode applied, remembering what Claude
 *  accepted or refused for this process. Claude rereads its settings, so bypass or auto it
 *  allowed earlier can be refused later; that refusal is followed by the fallback. */
export async function setClaudeAllowedPermissionMode(
  session: ClaudeBypassFacts & {
    connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
  },
  mode: PermissionMode,
  options?: { timeoutMs?: number }
): Promise<PermissionMode> {
  const ladder = claudePermissionModeLadder(session, mode)
  const writes = await Promise.allSettled(
    ladder.map((step) => session.connection.setPermissionMode(step, options))
  )
  let applied: PermissionMode | null = null
  let refusedLast = false
  for (const [index, write] of writes.entries()) {
    const step = ladder[index]
    if (write.status === 'fulfilled') {
      applied = step
      refusedLast = false
      if (step === 'bypassPermissions') {
        session.bypassDisabled = false
      } else if (step === 'auto') {
        session.autoDisabled = false
      }
      continue
    }
    const refusal = claudeRefusal(write.reason)
    if (refusal === null || (refusal === 'bypass') !== (step === 'bypassPermissions')) {
      throw write.reason
    }
    refusedLast = true
    if (refusal === 'bypass') {
      session.bypassDisabled = true
    } else {
      session.autoDisabled = true
    }
  }
  if (applied !== null && !refusedLast) {
    return applied
  }
  const next = claudeAllowedPermissionMode(session, mode)
  if (applied === next) {
    return applied
  }
  // Every step written was refused (a refusal of a mode allowed earlier). Each refusal is a new
  // fact, so this asks again at most twice.
  return setClaudeAllowedPermissionMode(session, mode, options)
}

/** A refused Full access chat outside Plan whose fallback no build switch has applied yet. */
export function claudeOwesFullAccessFallback(
  session: ClaudeBypassFacts &
    Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'> &
    Partial<Pick<ClaudeSession, 'orderedPermissionMode'>>
): boolean {
  const running = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  return (
    claudeBypassRefused(session) &&
    !session.appliedInputOptions.has('buildPermissionMode') &&
    session.appliedInputOptions.get('interactionMode') !== 'plan' &&
    running !== 'plan'
  )
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
    text: `Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses ${running} instead.`
  }
}

/** One warning row on the first root init after Claude's refusal is known. */
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
