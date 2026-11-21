// ACP has no standard skill delivery; use each agent's per-process configuration.

import { hasReachedAppVersion } from '../../../shared/app-lifecycle/identity/app-version'
import { readOpenCodeInlineConfig } from '../../opencode/opencode-inline-config'
import type { NativeChatSkillRoot } from '../../native-chat/native-chat-skill-roots'

export type AcpSkillRootsInput = {
  roots: readonly NativeChatSkillRoot[]
  version: string | null
  env: Readonly<Record<string, string>>
}

export type AcpSkillRootsLaunch = {
  /** The roots the agent loads; the rest reach it only through its instructions. */
  loaded: readonly NativeChatSkillRoot[]
  pluginDirs: readonly string[]
  env?: Record<string, string>
}

/** Null: the agent loads none of the roots. */
export type AcpSkillRootsLoader = (input: AcpSkillRootsInput) => Promise<AcpSkillRootsLaunch | null>

function pluginDirsLaunch(roots: readonly NativeChatSkillRoot[]): AcpSkillRootsLaunch | null {
  return roots.length > 0
    ? { loaded: roots, pluginDirs: roots.map((root) => root.pluginDir) }
    : null
}

// Unknown flags stop Grok; 1.0.44 is the oldest verified plugin-dir release.
const GROK_PLUGIN_DIR_FIRST_VERSION = '1.0.44'

// Grok 1.0.77 plugin folders skip linked skills (entries or the whole skills/), so those are listed instead.
export const loadGrokSkillRoots: AcpSkillRootsLoader = async ({ roots, version }) =>
  version !== null && hasReachedAppVersion(version, GROK_PLUGIN_DIR_FIRST_VERSION)
    ? pluginDirsLaunch(roots.filter((root) => !root.linksOut))
    : null

/** Extend inline skill paths only when the existing configuration can be preserved. */
export function withOpenCodeSkillsPaths(
  content: string | undefined,
  skillsRoots: readonly string[]
): string | null {
  const config = readOpenCodeInlineConfig(content)
  if (!config) {
    return null
  }
  const skills: unknown = config.skills
  // OpenCode 2.x also accepts a bare path/URL list.
  if (Array.isArray(skills)) {
    return JSON.stringify({ ...config, skills: [...skills, ...skillsRoots] })
  }
  if (skills === undefined) {
    return JSON.stringify({ ...config, skills: { paths: [...skillsRoots] } })
  }
  if (typeof skills !== 'object' || skills === null) {
    return null
  }
  const paths: unknown = 'paths' in skills ? skills.paths : []
  return Array.isArray(paths)
    ? JSON.stringify({ ...config, skills: { ...skills, paths: [...paths, ...skillsRoots] } })
    : null
}

// OpenCode 1.x replaces user skill paths; 2.x merges inline paths with configured lists.
const OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION = '2.0.14'

export const loadOpenCodeSkillRoots: AcpSkillRootsLoader = async ({ roots, env, version }) => {
  if (
    roots.length === 0 ||
    version === null ||
    !hasReachedAppVersion(version, OPENCODE_MERGED_SKILL_PATHS_FIRST_VERSION)
  ) {
    return null
  }
  const content = withOpenCodeSkillsPaths(
    env.OPENCODE_CONFIG_CONTENT,
    roots.map((root) => root.skillsRoot)
  )
  return content === null
    ? null
    : { loaded: roots, pluginDirs: [], env: { OPENCODE_CONFIG_CONTENT: content } }
}

// OMP 18.1.5–18.1.8 accept plugin-dir but skip its skills by default, so they load none.
const OMP_PLUGIN_SKILLS_SKIPPED = { first: '18.1.5', after: '18.1.9' }

export const loadOmpSkillRoots: AcpSkillRootsLoader = async ({ roots, version }) =>
  version !== null &&
  hasReachedAppVersion(version, OMP_PLUGIN_SKILLS_SKIPPED.first) &&
  !hasReachedAppVersion(version, OMP_PLUGIN_SKILLS_SKIPPED.after)
    ? null
    : pluginDirsLaunch(roots)

// Copilot adds these to its own skill folders and follows linked skills; the list is comma-separated.
export const loadCopilotSkillRoots: AcpSkillRootsLoader = async ({ roots, env }) => {
  const loaded = roots.filter((root) => !root.skillsRoot.includes(','))
  if (loaded.length === 0) {
    return null
  }
  const dirs = loaded.map((root) => root.skillsRoot).join(',')
  const inherited = env.COPILOT_SKILLS_DIRS?.trim()
  return {
    loaded,
    pluginDirs: [],
    env: { COPILOT_SKILLS_DIRS: inherited ? `${inherited},${dirs}` : dirs }
  }
}
