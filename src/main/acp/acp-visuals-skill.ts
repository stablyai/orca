// How each ACP agent loads the chat-visuals skill for one launch, without touching the user's own
// config: ACP itself has no way to hand an agent a skill.

import { isStableCliVersionFrom } from '../agent-cli-version-probe'
import type { NativeChatVisualsSkillLocation } from '../native-chat/native-chat-visuals-skill-location'

export type AcpVisualsSkillInput = {
  skill: NativeChatVisualsSkillLocation
  /** The `--version` the launch's binary printed; null when it printed none. */
  version: string | null
  /** What the child will see: its inherited environment with the launch's laid over it. */
  env: Readonly<Record<string, string>>
}

/** What a launch adds so the agent finds the skill: a plugin folder the agent's args name, and/or
 *  variables laid over its environment. */
export type AcpVisualsSkillLaunch = {
  pluginDir?: string
  env?: Record<string, string>
}

/** Null: this launch can't load the skill, so the chat starts without visuals. */
export type AcpVisualsSkillLoader = (
  input: AcpVisualsSkillInput
) => Promise<AcpVisualsSkillLaunch | null>

// Why 1.0.44: the oldest release checked that has `agent --plugin-dir`; an unknown flag stops Grok.
const GROK_PLUGIN_DIR_FIRST_VERSION = '1.0.44'

/** Grok takes Claude's plugin layout through `agent --plugin-dir`, for this process only. */
export const loadGrokVisualsSkill: AcpVisualsSkillLoader = async ({ skill, version }) =>
  version !== null && isStableCliVersionFrom(version, GROK_PLUGIN_DIR_FIRST_VERSION)
    ? { pluginDir: skill.pluginDir }
    : null

/** `content` (the user's own inline config, if any) with `skillsRoot` added to its skill paths;
 *  null when that config is not one this can extend safely. */
export function withOpenCodeSkillsPath(
  content: string | undefined,
  skillsRoot: string
): string | null {
  let config: unknown
  try {
    config = content?.trim() ? JSON.parse(content) : {}
  } catch {
    // JSONC or a typo: rewriting it would drop the user's settings.
    return null
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null
  }
  const skills: unknown = 'skills' in config ? config.skills : undefined
  // 2.x also takes a bare list of paths and URLs.
  if (Array.isArray(skills)) {
    return JSON.stringify({ ...config, skills: [...skills, skillsRoot] })
  }
  if (skills === undefined) {
    return JSON.stringify({ ...config, skills: { paths: [skillsRoot] } })
  }
  if (typeof skills !== 'object' || skills === null) {
    return null
  }
  const paths: unknown = 'paths' in skills ? skills.paths : []
  return Array.isArray(paths)
    ? JSON.stringify({ ...config, skills: { ...skills, paths: [...paths, skillsRoot] } })
    : null
}

// Why 2.x: 2.x adds inline `skills.paths` to the config files' list; 1.x lets it replace the
// user's own, so their skills would vanish from Orca's chats.
const OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION = '2.0.14'

/** OpenCode reads `skills.paths` from the inline config variable. */
export const loadOpenCodeVisualsSkill: AcpVisualsSkillLoader = async ({ skill, env, version }) => {
  if (
    version === null ||
    !isStableCliVersionFrom(version, OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION)
  ) {
    return null
  }
  const content = withOpenCodeSkillsPath(env.OPENCODE_CONFIG_CONTENT, skill.skillsRoot)
  return content === null ? null : { env: { OPENCODE_CONFIG_CONTENT: content } }
}

// No gate: 17.0.5+ has `--plugin-dir`, but 18.1.5-18.1.8 skip its skills by default (no visuals).
/** OMP takes Claude's plugin layout through `--plugin-dir` too, for this process only, beside the
 *  user's own plugins and skill folders. */
export const loadOmpVisualsSkill: AcpVisualsSkillLoader = async ({ skill }) => ({
  pluginDir: skill.pluginDir
})
