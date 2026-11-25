import type { AcpSessionEvent } from '../protocol/acp-session-events'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { acpWithCurrentMode } from '../options/acp-select-choices'
import { absorbsAcpModelCommandOutput } from '../turns/acp-model-command'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { asReattachHistory } from '../history/acp-reattach-history'

/** Updates that change the session's options, each of which reports them to the chat. */
export function reportsAcpOptions(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === 'config_option_update' ||
    update.sessionUpdate === 'current_mode_update'
  )
}

/** Update options before journaling so synchronous reads see the latest frame. */
export function routeAcpSessionEvent(
  session: Pick<AcpStructuredSession, 'lane' | 'options'>,
  event: AcpSessionEvent,
  at: number,
  reattaching = false
): void {
  if (
    event.kind === 'known' &&
    event.notification.sessionId === session.lane.translator.providerSessionId
  ) {
    const { update } = event.notification
    if (update.sessionUpdate === 'available_commands_update') {
      session.options.adoptCommands(update.availableCommands)
    } else if (update.sessionUpdate === 'config_option_update') {
      session.options.adoptConfigOptions(update.configOptions)
    } else if (update.sessionUpdate === 'current_mode_update') {
      // A mode the agent switched to itself, e.g. after an approval that allows every edit.
      session.options.adoptConfigOptions(
        acpWithCurrentMode(session.options.configOptions, update.currentModeId)
      )
    }
  }
  if (absorbsAcpModelCommandOutput(session.options, event)) {
    return
  }
  const { translator } = session.lane
  session.lane.apply(
    reattaching
      ? translator.notification(
          'session/update',
          asReattachHistory(event.kind === 'known' ? event.notification : event.raw),
          at
        )
      : translator.sessionEvent(event, at)
  )
}
