import { buildTuiAgentRoster, type TuiAgentRoster } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CommandHandler } from '../dispatch'

export function formatAgentRoster(roster: TuiAgentRoster): string {
  return [
    `Enabled (configured; not detected/installed): ${
      roster.enabled.length > 0 ? roster.enabled.join(', ') : 'none'
    }`,
    `Disabled: ${roster.disabled.length > 0 ? roster.disabled.join(', ') : 'none'}`,
    `Default: ${roster.default ?? 'none'}`
  ].join('\n')
}

export const AGENT_ROSTER_HANDLERS: Record<string, CommandHandler> = {
  'agent roster': async ({ client, json }) => {
    const response = await client.call<{
      settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>
    }>('settings.get')
    const roster = buildTuiAgentRoster(response.result.settings)
    if (json) {
      console.log(JSON.stringify(roster, null, 2))
      return
    }
    console.log(formatAgentRoster(roster))
  }
}
