import type { ClaudeSession } from '../claude-structured-session-state'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeOwesPermissionFallback
} from './claude-full-access-refusal'
import {
  recordClaudeBuildPermissionMode,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'

type ClaudeRootInit = NonNullable<ClaudeSession['actualFirstRootInit']>

export function readClaudeRootInit(message: Record<string, unknown>): ClaudeRootInit | undefined {
  if (message.type === 'system' && message.subtype === 'init' && isRootClaudeFrame(message)) {
    return { permissionMode: readClaudeFrameString(message, 'permissionMode') }
  }
}

function latchClaudeRootInit(
  session: ClaudeSession,
  init: ClaudeRootInit
): ClaudeRootInit | undefined {
  if (session.actualFirstRootInit) {
    return
  }
  const root: ClaudeRootInit =
    init.permissionMode === 'default' && session.autoUnansweredAskRequest !== undefined
      ? { permissionMode: init.permissionMode, source: 'unanswered-auto-ask' }
      : init
  session.actualFirstRootInit = root
  if (!session.firstRootInit || session.firstRootInit.source === 'initialize') {
    session.firstRootInit = root
  }
  return root
}

function settleClaudeAutoStartup(session: ClaudeSession, root: ClaudeRootInit): void {
  const opened = root.permissionMode
  if (
    root.source === 'unanswered-auto-ask' ||
    opened === null ||
    opened === 'auto' ||
    opened === 'plan' ||
    claudeAutoFallbackReason(session) === null ||
    !claudeOwesPermissionFallback(session)
  ) {
    return
  }
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

export function observeClaudeRootInit(session: ClaudeSession | null, init: ClaudeRootInit): void {
  if (!session) {
    return
  }
  const root = latchClaudeRootInit(session, init)
  if (session.launchIntent?.permissionMode === 'auto') {
    if (root) {
      settleClaudeAutoStartup(session, root)
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
        recordClaudeBuildPermissionMode(session, mode)
      }
    },
    () => {
      if (session.permissionModeRequests === request) {
        session.appliedInputOptions.delete('buildPermissionMode')
      }
    }
  )
}

export function adoptClaudeLaunchRootInit(
  session: ClaudeSession,
  init: ClaudeRootInit | undefined
): () => void {
  const root = init && latchClaudeRootInit(session, init)
  return () => {
    if (root && session.launchIntent?.permissionMode === 'auto') {
      settleClaudeAutoStartup(session, root)
    }
  }
}
