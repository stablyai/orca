import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import {
  codexEffortFromChoices,
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../shared/agent-session-option-catalog'
import type { RoomParticipant } from '../../../shared/rooms'

export function roomParticipantRestartPreferences(
  participant: RoomParticipant
): AgentLaunchPreferences | undefined {
  if (!participant.agent) {
    return undefined
  }
  const catalog = getAgentSessionOptionCatalog(
    participant.agent === 'openclaude' ? 'claude' : participant.agent
  )
  if (!catalog) {
    return undefined
  }
  const preferences: AgentLaunchPreferences = {}
  const { model, effort, fastMode } = participant.context
  if (
    model &&
    (catalog.capturesOptionsInLaunchCommand || catalog.modelApply.midSession?.kind === 'restart')
  ) {
    preferences.model = model
  }
  const effortOption =
    findCatalogOption(findCatalogModel(catalog, model ?? ''), 'effort') ??
    (participant.agent === 'codex' ? codexEffortFromChoices() : undefined)
  if (
    effort &&
    (catalog.capturesOptionsInLaunchCommand || effortOption?.apply.midSession?.kind === 'restart')
  ) {
    preferences.effort = effort
  }
  if (typeof fastMode === 'boolean' && catalog.capturesOptionsInLaunchCommand) {
    preferences.mode = fastMode ? 'fast' : 'standard'
  }
  return preferences.model || preferences.effort || preferences.mode ? preferences : undefined
}
