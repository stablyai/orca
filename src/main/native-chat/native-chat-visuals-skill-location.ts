// Resolve on the execution host; a client’s install paths are meaningless remotely.

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

const PLUGIN_DIR_NAME = 'native-chat-visuals'
export const NATIVE_CHAT_VISUALS_SKILL_NAME = 'orca-chat-visuals'

export type NativeChatVisualsSkillLocation = {
  /** Contains .claude-plugin/plugin.json and skills/<name>/SKILL.md. */
  pluginDir: string
  /** Codex expects the plugin’s skills directory as its root. */
  skillsRoot: string
}

function candidatePluginDirs(): string[] {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, PLUGIN_DIR_NAME))
  }
  const packaged = hasAppEnvironment() && getAppEnvironment().isPackaged()
  if (packaged) {
    // Plain-Node orcad uses its app root; packaged installs must never fall back to launch-directory checkouts.
    candidates.push(join(getAppEnvironment().getAppPath(), PLUGIN_DIR_NAME))
    return candidates
  }
  for (const root of [
    hasAppEnvironment() ? getAppEnvironment().getAppPath() : null,
    process.cwd()
  ]) {
    if (root) {
      candidates.push(join(root, 'resources', PLUGIN_DIR_NAME))
    }
  }
  return candidates
}

async function isComplete(pluginDir: string): Promise<boolean> {
  try {
    await Promise.all([
      access(join(pluginDir, '.claude-plugin', 'plugin.json')),
      access(join(pluginDir, 'skills', NATIVE_CHAT_VISUALS_SKILL_NAME, 'SKILL.md'))
    ])
    return true
  } catch {
    return false
  }
}

let found: NativeChatVisualsSkillLocation | null = null

/** Cache only found locations so missing plugins can appear later. */
export async function resolveNativeChatVisualsSkillLocation(
  candidates: readonly string[] = candidatePluginDirs()
): Promise<NativeChatVisualsSkillLocation | null> {
  if (found) {
    return found
  }
  for (const pluginDir of candidates) {
    if (await isComplete(pluginDir)) {
      found = { pluginDir, skillsRoot: join(pluginDir, 'skills') }
      return found
    }
  }
  return null
}

export function resetNativeChatVisualsSkillLocationForTests(): void {
  found = null
}
