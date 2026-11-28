import type { ClaudeSession } from '../claude-structured-session-state'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeOwesPermissionFallback
} from './claude-full-access-refusal'
import { journalClaudeSessionPermissionNotice } from './claude-full-access-refusal-notice'
import { claudePermissionPickHolds } from './claude-permission-picks'
import {
  recordClaudeBuildPermissionMode,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'

type ClaudeRootInit = NonNullable<ClaudeSession['actualFirstRootInit']>

/** The mode initialize reports Claude opened in: startup evidence until a root init outranks it. */
export function adoptClaudeInitializePermissionMode(session: ClaudeSession, opened: string): void {
  if (session.startupPermissionMode === undefined) {
    session.startupPermissionMode = opened
  }
  if (!session.firstRootInit) {
    session.firstRootInit =
      session.launchIntent?.permissionMode === 'auto'
        ? { permissionMode: opened, source: 'initialize' }
        : { permissionMode: opened }
  }
}

/** The startup settings read's answer on auto: an Approve for me chat's warning waited for it. */
export function settleClaudeStartupAutoDisabled(
  session: ClaudeSession,
  autoDisabled: boolean | undefined
): void {
  const autoNewlyDisabled = autoDisabled === true && session.autoDisabled !== true
  session.autoDisabled = autoDisabled
  if (session.launchIntent?.permissionMode !== 'auto') {
    return
  }
  const pending = session.startupSettings
  session.startupSettings = undefined
  if (autoNewlyDisabled || (pending && claudeAutoFallbackReason(session) === 'started-outside')) {
    journalClaudeSessionPermissionNotice(session)
  }
}

export function readClaudeRootInit(message: Record<string, unknown>): ClaudeRootInit | undefined {
  if (message.type === 'system' && message.subtype === 'init' && isRootClaudeFrame(message)) {
    return { permissionMode: readClaudeFrameString(message, 'permissionMode') }
  }
  return undefined
}

export function adoptClaudeLaunchRootInit(
  session: ClaudeSession,
  init: ClaudeRootInit | undefined
): void {
  if (!init || session.actualFirstRootInit) {
    return
  }
  const root: ClaudeRootInit =
    init.permissionMode === 'default' && session.autoUnansweredAskRequest !== undefined
      ? { permissionMode: init.permissionMode, source: 'unanswered-auto-ask' }
      : init
  session.actualFirstRootInit = root
  if (session.permissionModeRequests === undefined && session.startupPermissionMode === undefined) {
    session.startupPermissionMode = root.permissionMode
  }
  if (!session.firstRootInit || session.firstRootInit.source === 'initialize') {
    session.firstRootInit = root
  }
  if (
    session.launchIntent?.permissionMode === 'auto' &&
    !session.connection.closed &&
    root.permissionMode === 'default' &&
    root.source === undefined &&
    session.permissionModeRequests === undefined &&
    claudeOwesPermissionFallback(session)
  ) {
    session.appliedInputOptions.set('buildPermissionMode', 'default')
  }
}

/** Claude's first root init: before open only recorded, after it the same start as open's. */
export function observeClaudeRootInit(session: ClaudeSession | null, init: ClaudeRootInit): void {
  if (!session) {
    return
  }
  adoptClaudeLaunchRootInit(session, init)
  if (session.initialization.startup.opened()) {
    startClaudeStartupFallback(session, session.permissionModeRequests)
  }
}

/** A Full access chat whose actual first root init shows bypass refused switches to its fallback
 *  now, so its tools run there rather than in Ask. `request` is the mode request current when
 *  the caller began waiting: a newer one (Plan, a send) decides instead. Never awaited, so an
 *  unanswered write can't hold the chat's readiness. */
export function startClaudeStartupFallback(
  session: ClaudeSession,
  request: number | undefined
): void {
  if (
    !session.actualFirstRootInit ||
    session.permissionModeRequests !== request ||
    !claudeBypassRefused(session) ||
    !claudeOwesPermissionFallback(session)
  ) {
    return
  }
  const holds = claudePermissionPickHolds(session)
  const write = setClaudeAllowedPermissionMode(session, 'bypassPermissions')
  const claimed = session.permissionModeRequests
  void write.then(
    (mode) => {
      if (mode !== undefined && holds() && session.permissionModeRequests === claimed) {
        recordClaudeBuildPermissionMode(session, mode)
        // No turn may follow to post it: the settled fallback's row replaces a saved recovery now.
        journalClaudeSessionPermissionNotice(session)
      }
    },
    () => {
      if (holds() && session.permissionModeRequests === claimed) {
        session.appliedInputOptions.delete('buildPermissionMode')
      }
    }
  )
}
