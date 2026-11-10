import { readContainedPluginArtifactText } from './plugin-contained-artifact'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import {
  isPluginWorktreeBadgeSvgIcon,
  PLUGIN_WORKTREE_BADGE_SVG_MAX_BYTES,
  type PluginWorktreeBadgeEntry,
  type PluginWorktreeBadgeIcon
} from '../../shared/plugins/contributions/plugin-worktree-badge-contribution'

const FALLBACK_BADGE_ICON: PluginWorktreeBadgeIcon = { kind: 'named', name: 'puzzle' }

/** The plugin's badges for clients, with each SVG icon read inline. */
export async function projectPluginWorktreeBadges(
  plugin: ValidDiscoveredPlugin
): Promise<PluginWorktreeBadgeEntry[]> {
  return Promise.all(
    plugin.manifest.contributes.worktreeBadges.map(async (badge) => ({
      id: badge.id,
      title: badge.title,
      icon: await resolveBadgeIcon(plugin.rootDir, badge.icon),
      when: {
        pathExists: [...badge.when.pathExists],
        searchDepth: badge.when.searchDepth,
        host: badge.when.host
      },
      commands: [...badge.commands]
    }))
  )
}

async function resolveBadgeIcon(rootDir: string, icon: string): Promise<PluginWorktreeBadgeIcon> {
  if (!isPluginWorktreeBadgeSvgIcon(icon)) {
    return { kind: 'named', name: icon }
  }
  try {
    const markup = await readContainedPluginArtifactText(
      rootDir,
      icon,
      PLUGIN_WORKTREE_BADGE_SVG_MAX_BYTES
    )
    return /<svg[\s>]/i.test(markup) ? { kind: 'svg', markup } : FALLBACK_BADGE_ICON
  } catch {
    // Why: a dev plugin can delete its icon mid-session; the badge stays usable.
    return FALLBACK_BADGE_ICON
  }
}
