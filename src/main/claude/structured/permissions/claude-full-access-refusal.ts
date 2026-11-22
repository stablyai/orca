// Claude runs a Full access launch in another mode when its settings turn bypass off
// (`permissions.disableBypassPermissionsMode`), and refuses any later switch to bypass.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeFullAccessRefusalReason,
  ClaudeSession
} from '../claude-structured-session-state'

export type ClaudeBypassFacts = Partial<
  Pick<
    ClaudeSession,
    | 'launchIntent'
    | 'firstRootInit'
    | 'bypassDisabled'
    | 'bypassAccepted'
    | 'bypassRefusal'
    | 'autoDisabled'
    | 'autoUnsettled'
    | 'appliedInputOptions'
    | 'permissionModeRequests'
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

/** A first init outside Full access shows a refusal a settings read cannot overrule (a host can
 *  block bypass whatever the settings say). A Plan start proves nothing. */
export function claudeBypassRefused(session: ClaudeBypassFacts): boolean {
  if (session.launchIntent?.permissionMode !== 'bypassPermissions') {
    return false
  }
  if (session.bypassDisabled === true) {
    return true
  }
  const opened = session.firstRootInit?.permissionMode
  return (
    session.bypassAccepted !== true &&
    typeof opened === 'string' &&
    opened !== 'bypassPermissions' &&
    opened !== 'plan'
  )
}

/** Claude's own refusal, else its settings read, else only that it started outside Full access. */
export function claudeFullAccessRefusalReason(
  session: ClaudeBypassFacts
): ClaudeFullAccessRefusalReason {
  return session.bypassRefusal ?? (session.bypassDisabled === true ? 'settings' : 'started-outside')
}

/** Nothing has said yet whether Claude allows this Full access launch's bypass. */
export function claudeBypassUnknown(session: ClaudeBypassFacts): boolean {
  return (
    session.launchIntent?.permissionMode === 'bypassPermissions' &&
    session.bypassDisabled === undefined &&
    session.bypassAccepted !== true &&
    session.firstRootInit?.permissionMode !== 'bypassPermissions' &&
    !claudeBypassRefused(session)
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

type ClaudeModeFacts = Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'> &
  Partial<Pick<ClaudeSession, 'orderedPermissionMode'>>

/** Plan as chosen or as Claude runs it, in wire order where known. */
export function claudeInPlan(session: ClaudeModeFacts): boolean {
  const running = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  return session.appliedInputOptions.get('interactionMode') === 'plan' || running === 'plan'
}

function claudeRunsAsk(session: ClaudeModeFacts): boolean {
  const running = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  return running === 'default' || running === 'ask'
}

/** A Full access chat outside Plan whose mode the next input should settle: nothing has said
 *  whether Claude allows bypass, or Claude refuses it and no fallback is applied, Claude has
 *  left the Approve for me it applied, or a refusal of auto may have passed. */
export function claudeOwesFullAccessFallback(
  session: ClaudeBypassFacts & ClaudeModeFacts
): boolean {
  if (session.launchIntent?.permissionMode !== 'bypassPermissions' || claudeInPlan(session)) {
    return false
  }
  const build = session.appliedInputOptions.get('buildPermissionMode')
  if (!claudeBypassRefused(session)) {
    return claudeBypassUnknown(session) && build === undefined
  }
  if (session.autoUnsettled !== undefined) {
    return claudeAutoRetryDue(session)
  }
  return build === undefined || (build === 'auto' && claudeRunsAsk(session))
}
