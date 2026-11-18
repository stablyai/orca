import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { CLAUDE_AGENT_VIEW_PLUGIN } from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'
import { parseHooksJsonText } from '../../agent-hooks/installation/configuration/hooks-json-read'
import { removeConfigLeftEmpty } from '../../agent-hooks/installation/configuration/hooks-json-empty-removal'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/profiles/claude-profile-homes'
import { getConfigPath } from '../hooks/hook-settings'
import { markerName, ownership } from './agent-view-binding-plan'
import { serializeClaudeAgentViewConfig } from './agent-view-config-lock'
import { removeClaudeAgentView } from './agent-view-install'
import { claudeAgentViewChord } from './agent-view-keybindings'

async function listClaudeConfigPaths(): Promise<string[]> {
  const homes = await listClaudeProfileHomesAsync(getAppEnvironment().getPath('userData'))
  return [undefined, ...homes].map((configDir) => getConfigPath(undefined, configDir))
}

export async function listClaudeKeybindingsPaths(): Promise<string[]> {
  return (await listClaudeConfigPaths()).map((path) => join(dirname(path), 'keybindings.json'))
}

async function isOwnedMarker(path: string): Promise<boolean> {
  const marker = parseHooksJsonText(await readFile(path, 'utf8').catch(() => '{}'))
  return marker?.owner === ownership.owner
}

function markerPaths(configPath: string): string[] {
  const configDir = dirname(configPath)
  return [
    join(configDir, markerName),
    join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN, '.claude-plugin', 'orca-managed.json')
  ]
}

async function findOwned(candidates: string[]): Promise<string[]> {
  const owned = await Promise.all(candidates.map(isOwnedMarker))
  return candidates.filter((_, index) => owned[index])
}

/** Orca's agent-view markers and the keybindings they own, even when no Claude hooks remain. */
export async function findClaudeAgentViewFiles(): Promise<string[]> {
  const files = await Promise.all(
    (await listClaudeConfigPaths()).map(async (configPath) => {
      const markers = await findOwned(markerPaths(configPath))
      const keybindings = join(dirname(configPath), 'keybindings.json')
      const bound =
        markers.length > 0 &&
        claudeAgentViewChord(await readFile(keybindings, 'utf8').catch(() => '')) !== undefined
      return bound ? [keybindings, ...markers] : markers
    })
  )
  return files.flat()
}

/** Uninstall only: drops the binding, then the marker a re-enable would use to remember opt-outs. */
export async function removeClaudeAgentViewForUninstall(): Promise<void> {
  for (const configPath of await listClaudeConfigPaths()) {
    await serializeClaudeAgentViewConfig(configPath, async () => {
      const markerPath = join(dirname(configPath), markerName)
      const touched = (await findOwned(markerPaths(configPath))).length > 0
      removeClaudeAgentView(configPath)
      const keybindings = join(dirname(configPath), 'keybindings.json')
      const left = parseHooksJsonText(await readFile(keybindings, 'utf8').catch(() => 'null'))
      // Orca creates this file for its binding; an emptied list alone is not the user's.
      if (
        touched &&
        left &&
        Object.keys(left).every((key) => key === 'bindings') &&
        Array.isArray(left.bindings) &&
        left.bindings.length === 0
      ) {
        await removeConfigLeftEmpty(keybindings)
      }
      // The writer's rolling .bak of this marker holds only Orca's own state.
      for (const path of [markerPath, `${markerPath}.bak`]) {
        if (await isOwnedMarker(path)) {
          await rm(path, { force: true })
        }
      }
    })
  }
}
