import { discoverAntigravityPluginSkillSources } from './antigravity-plugin-skill-sources'
import {
  applyClaudePluginManifestNames,
  discoverClaudePluginSkillInstalls
} from './claude-plugin-skill-sources'
import type { SkillScanRoot } from './skill-discovery-sources'

/** Skill roots of the plugins Claude and Antigravity load for a workspace. */
export async function discoverPluginSkillSources(args: {
  homeDir: string
  cwd: string
  signal?: AbortSignal
}): Promise<SkillScanRoot[]> {
  const [claude, antigravity] = await Promise.all([
    discoverClaudePluginSkillInstalls(args).then((installs) =>
      applyClaudePluginManifestNames(installs, args.signal)
    ),
    discoverAntigravityPluginSkillSources(args)
  ])
  return [...claude, ...antigravity]
}
