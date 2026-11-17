import type { TraexSession } from './traex-session'
import { reportedTraexPermissionMode } from './traex-permission-mode'
import { traexRecord, traexText } from './traex-protocol'

/** Apply a settings report from the CLI so pickers and the next turn agree with the thread. */
export function applyTraexThreadSettings(session: TraexSession, value: unknown): void {
  const settings = traexRecord(value)
  const model = traexText(settings.model)
  if (model) {
    const known = session.nativeModels.find((entry) => entry.id === model || entry.model === model)
    session.options.model = known?.id ?? model
    session.reportedModel = model
  }
  const effort = traexText(settings.effort)
  if (effort) {
    session.options.effort = effort
  }
  const collaboration = traexRecord(settings.collaborationMode)
  const mode = traexText(collaboration.mode)
  if (mode === 'plan' || mode === 'default') {
    session.options.interactionMode = mode
    if (!session.activeTurn) {
      session.ranOptions.interactionMode = mode
    }
  }
  const permission = reportedTraexPermissionMode(settings)
  if (permission) {
    session.reportedPermissionMode = permission
  }
  session.input.events?.publish()
}
