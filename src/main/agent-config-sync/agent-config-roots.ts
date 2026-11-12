import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentConfigItemKind,
  AgentConfigItemScope
} from '../../shared/agent-config-sync/agent-config-sync-contract'
import { AGENT_CONFIG_FILE_KINDS } from '../../shared/agent-config-sync/agent-config-sync-contract'

export type AgentConfigHomes = {
  /** Claude Code's config dir: $CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeDir: string
  /** $CODEX_HOME or ~/.codex. */
  codexDir: string
  home: string
}

export function defaultAgentConfigHomes(env: NodeJS.ProcessEnv = process.env): AgentConfigHomes {
  const home = homedir()
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
    codexDir: env.CODEX_HOME?.trim() || join(home, '.codex'),
    home
  }
}

/** The folder that holds every item of a kind; null when the kind has no such scope. */
export function agentConfigRoot(
  kind: AgentConfigItemKind,
  scope: AgentConfigItemScope,
  homes: AgentConfigHomes,
  projectPath: string | null
): string | null {
  if (scope === 'project') {
    if (!projectPath) {
      return null
    }
    switch (kind) {
      case 'claude-skill':
        return join(projectPath, '.claude', 'skills')
      case 'claude-command':
        return join(projectPath, '.claude', 'commands')
      case 'agents-skill':
        return join(projectPath, '.agents', 'skills')
      case 'claude-agent':
        return join(projectPath, '.claude', 'agents')
      // Home only: Codex prompts and its older skills folder; output styles; memory (a project's
      // CLAUDE.md is committed, and CLAUDE.local.md is per-machine by design).
      case 'codex-skill':
      case 'codex-prompt':
      case 'claude-output-style':
      case 'claude-memory':
      case 'codex-memory':
        return null
    }
  }
  switch (kind) {
    case 'claude-skill':
      return join(homes.claudeDir, 'skills')
    case 'claude-command':
      return join(homes.claudeDir, 'commands')
    case 'agents-skill':
      return join(homes.home, '.agents', 'skills')
    case 'codex-skill':
      return join(homes.codexDir, 'skills')
    case 'codex-prompt':
      return join(homes.codexDir, 'prompts')
    case 'claude-agent':
      return join(homes.claudeDir, 'agents')
    case 'claude-output-style':
      return join(homes.claudeDir, 'output-styles')
    // Memory sits in the config folder itself as <name>.md (CLAUDE.md, AGENTS.md).
    case 'claude-memory':
      return homes.claudeDir
    case 'codex-memory':
      return homes.codexDir
  }
}

/** Where one item lives under its root: a folder for skills, `<name>.md` for commands. */
export function agentConfigItemPath(root: string, kind: AgentConfigItemKind, name: string): string {
  return AGENT_CONFIG_FILE_KINDS.has(kind)
    ? join(root, ...`${name}.md`.split('/'))
    : join(root, name)
}
