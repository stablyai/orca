import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { ClaudeStatsCacheHomeRef } from '../../shared/agent-usage/analytics/claude-usage-types'
import {
  claudeProfileConfigHomes,
  getClaudeProfileRouter
} from '../claude-accounts/profiles/routing/claude-profile-installed-router'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../claude-accounts/profiles/claude-profile-paths'

function tildePath(path: string): string {
  const fromHome = relative(homedir(), path)
  return fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)
    ? join('~', fromHome)
    : path
}

/** Resolved by the host process: the usage service has no account router of its own. */
export function listClaudeStatsCacheHomes(): ClaudeStatsCacheHomeRef[] {
  const router = getClaudeProfileRouter()
  // Headless hosts have no profile router, so read their inherited CLAUDE_CONFIG_DIR directly.
  const inherited = router ? undefined : readUserClaudeConfigDir(process.env)
  const homes = new Set([
    resolveClaudeDefaultHome(homedir()),
    ...claudeProfileConfigHomes(),
    ...(inherited ? [inherited] : [])
  ])
  return [...homes].map((home) => ({
    home,
    label: router?.savedAccountForHome(home)?.email || tildePath(home)
  }))
}
