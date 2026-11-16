import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { parseHooksJsonText } from '../../agent-hooks/installation/configuration/hooks-json-read'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/profiles/claude-profile-homes'
import { getConfigPath } from '../hooks/hook-settings'
import { markerName, ownership } from './agent-view-binding-plan'

/** Uninstall only: disabling keeps the marker so a re-enable remembers opt-outs; none will come. */
export async function forgetClaudeAgentViewMarkers(): Promise<void> {
  const homes = await listClaudeProfileHomesAsync(getAppEnvironment().getPath('userData'))
  for (const configDir of [undefined, ...homes]) {
    const markerPath = join(dirname(getConfigPath(undefined, configDir)), markerName)
    // The writer's rolling .bak of this marker holds only Orca's own state.
    for (const path of [markerPath, `${markerPath}.bak`]) {
      const marker = parseHooksJsonText(await readFile(path, 'utf8').catch(() => '{}'))
      if (marker?.owner === ownership.owner) {
        await rm(path, { force: true })
      }
    }
  }
}
