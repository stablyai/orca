import type { ClaudeSession } from '../claude-structured-session-state'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import {
  cacheClaudeRootAsk,
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
  if (!session.firstRootInit || session.firstRootInit.source === 'initialize') {
    session.firstRootInit = root
  }
  if (session.permissionModeRequests === undefined) {
    cacheClaudeRootAsk(session)
  }
}

export function observeClaudeRootInit(session: ClaudeSession | null, init: ClaudeRootInit): void {
  if (!session) {
    return
  }
  adoptClaudeLaunchRootInit(session, init)
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
