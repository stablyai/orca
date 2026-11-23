import type { ClaudeSession } from '../claude-structured-session-state'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import { claudeBypassRefused, claudeOwesPermissionFallback } from './claude-full-access-refusal'
import { readClaudeEarlierRefusalNotice } from './claude-full-access-refusal-notice'
import {
  recordClaudeBuildPermissionMode,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'

type ClaudeRootInit = NonNullable<ClaudeSession['actualFirstRootInit']>

export function readClaudeStartupPermissionNotice(
  session: ClaudeSession,
  assertCurrent: () => void,
  afterJournalBinding = false
): Promise<void> {
  const start = async () =>
    readClaudeEarlierRefusalNotice(
      session,
      session.events?.journalHistory?.()?.reads,
      assertCurrent
    )
  // Install the promise before root init can arrive, even when the host has yet to bind the journal.
  const read = afterJournalBinding
    ? new Promise<void>((resolve) => session.delivery.deliver(() => resolve(start())))
    : start()
  session.fullAccessRefusalNoticeRead = read
  void read.catch(() => {})
  return read
}

export function prepareClaudeRootInit(
  session: ClaudeSession,
  init: ClaudeRootInit | undefined,
  sessions: ReadonlyMap<string, ClaudeSession>,
  sessionId: string,
  signal: AbortSignal | undefined
): void {
  const events = session.events
  if (
    session.launchIntent?.permissionMode === 'bypassPermissions' &&
    events?.journalHistory &&
    (events.onJournalBound || events.journalHistory())
  ) {
    readClaudeStartupPermissionNotice(
      session,
      () => {
        if (sessions.get(sessionId) !== session || signal?.aborted) {
          throw new Error('claude session closed before startup completed')
        }
      },
      true
    )
  }
  adoptClaudeLaunchRootInit(session, init)
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

export async function observeClaudeRootInit(
  session: ClaudeSession | null,
  init: ClaudeRootInit,
  current: () => ClaudeSession | undefined
): Promise<void> {
  if (!session) {
    return
  }
  adoptClaudeLaunchRootInit(session, init)
  if (!claudeBypassRefused(session) || !claudeOwesPermissionFallback(session)) {
    return
  }
  const noticeRead = session.fullAccessRefusalNoticeRead
  if (noticeRead) {
    const request = session.permissionModeRequests
    try {
      await noticeRead
    } catch {
      return
    }
    if (
      current() !== session ||
      !session.delivery.ready ||
      session.connection.closed ||
      session.permissionModeRequests !== request ||
      !claudeBypassRefused(session) ||
      !claudeOwesPermissionFallback(session)
    ) {
      return
    }
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
