import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SkillDiscoverySource, SkillProvider, SkillSourceKind } from '../../shared/skills'
import type { Repo } from '../../shared/types'

export type SkillScanRoot = Omit<SkillDiscoverySource, 'exists' | 'skippedReason'>

export function stablePathId(pathValue: string): string {
  return createHash('sha1').update(pathValue).digest('hex').slice(0, 16)
}

function source(
  id: string,
  label: string,
  path: string,
  sourceKind: SkillSourceKind,
  providers: SkillProvider[]
): SkillScanRoot {
  return { id, label, path, sourceKind, providers }
}

export function buildSkillDiscoverySources(
  args: {
    homeDir?: string
    cwd?: string
    repos?: Repo[]
  } = {}
): SkillScanRoot[] {
  const home = args.homeDir ?? homedir()
  const cwd = args.cwd ?? process.cwd()
  const roots: SkillScanRoot[] = [
    source('home-codex', 'Codex home', join(home, '.codex', 'skills'), 'home', ['codex']),
    source('home-agents', 'Agent skills home', join(home, '.agents', 'skills'), 'home', [
      'agent-skills'
    ]),
    source('home-claude', 'Claude home', join(home, '.claude', 'skills'), 'home', ['claude']),
    source(
      'codex-plugin-cache',
      'Codex plugin cache',
      join(home, '.codex', 'plugins', 'cache'),
      'plugin',
      ['codex', 'agent-skills']
    ),
    // Why: `npx skills add --global` writes into each agent's own home skills
    // directory, so coverage misses them unless we scan every provider root.
    source('home-grok', 'Grok home', join(home, '.grok', 'skills'), 'home', ['agent-skills']),
    source('home-opencode', 'OpenCode home', join(home, '.config', 'opencode', 'skills'), 'home', [
      'agent-skills'
    ]),
    source('home-pi', 'Pi home', join(home, '.pi', 'agent', 'skills'), 'home', ['agent-skills']),
    source('home-gemini', 'Gemini home', join(home, '.gemini', 'skills'), 'home', ['agent-skills']),
    source(
      'home-antigravity',
      'Antigravity home',
      join(home, '.gemini', 'antigravity', 'skills'),
      'home',
      ['agent-skills']
    ),
    source('home-cursor', 'Cursor home', join(home, '.cursor', 'skills'), 'home', ['agent-skills'])
  ]

  const projectPaths = new Set<string>()
  for (const repo of args.repos ?? []) {
    if (repo.connectionId) {
      continue
    }
    projectPaths.add(repo.path)
  }
  projectPaths.add(cwd)

  for (const repoPath of projectPaths) {
    const label = `Repo ${basename(repoPath)}`
    roots.push(
      source(
        `repo-agents-${stablePathId(repoPath)}`,
        `${label} .agents`,
        join(repoPath, '.agents', 'skills'),
        'repo',
        ['agent-skills']
      ),
      source(
        `repo-claude-${stablePathId(repoPath)}`,
        `${label} .claude`,
        join(repoPath, '.claude', 'skills'),
        'repo',
        ['claude']
      )
    )
  }

  return roots
}
