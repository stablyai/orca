// ACP has no standard skill delivery; use each agent's per-process configuration.

import { hasReachedAppVersion } from '../../shared/app-version'
import type { NativeChatVisualsSkillLocation } from '../native-chat/native-chat-visuals-skill-location'

export type AcpVisualsSkillInput = {
  skill: NativeChatVisualsSkillLocation
  version: string | null
  env: Readonly<Record<string, string>>
}

export type AcpVisualsSkillLaunch = {
  pluginDir?: string
  env?: Record<string, string>
}

export type AcpVisualsSkillLoader = (
  input: AcpVisualsSkillInput
) => Promise<AcpVisualsSkillLaunch | null>

// Unknown flags stop Grok; 1.0.44 is the oldest verified plugin-dir release.
const GROK_PLUGIN_DIR_FIRST_VERSION = '1.0.44'

export const loadGrokVisualsSkill: AcpVisualsSkillLoader = async ({ skill, version }) =>
  version !== null && hasReachedAppVersion(version, GROK_PLUGIN_DIR_FIRST_VERSION)
    ? { pluginDir: skill.pluginDir }
    : null

/** Extend inline skill paths only when the existing configuration can be preserved. */
export function withOpenCodeSkillsPath(
  content: string | undefined,
  skillsRoot: string
): string | null {
  let config: unknown
  try {
    config = content?.trim() ? JSON.parse(content) : {}
  } catch {
    // Rewriting JSONC or malformed JSON would lose user settings.
    return null
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null
  }
  const skills: unknown = 'skills' in config ? config.skills : undefined
  // OpenCode 2.x also accepts a bare path/URL list.
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

// OpenCode 1.x replaces user skill paths; 2.x merges inline paths with configured lists.
const OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION = '2.0.14'

export const loadOpenCodeVisualsSkill: AcpVisualsSkillLoader = async ({ skill, env, version }) => {
  if (
    version === null ||
    !hasReachedAppVersion(version, OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION)
  ) {
    return null
  }
  const content = withOpenCodeSkillsPath(env.OPENCODE_CONFIG_CONTENT, skill.skillsRoot)
  return content === null ? null : { env: { OPENCODE_CONFIG_CONTENT: content } }
}

// OMP 18.1.5–18.1.8 accept plugin-dir but skip its skills by default.
export const loadOmpVisualsSkill: AcpVisualsSkillLoader = async ({ skill }) => ({
  pluginDir: skill.pluginDir
})
