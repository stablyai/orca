import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTrustPreset } from './agent-trust-presets'

/** Whether any trust entry for `preset` landed under `home` (Claude's config lives in the home). */
export function workspaceTrustWritten(home: string, preset: AgentTrustPreset): boolean {
  switch (preset) {
    case 'kimi':
      return existsSync(join(home, '.kimi-code', 'workspace-trust'))
    case 'claude':
      return 'projects' in JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    case 'codex':
      return existsSync(join(home, '.codex', 'config.toml'))
    case 'cursor': {
      const projects = join(home, '.cursor', 'projects')
      return existsSync(projects) && readdirSync(projects).length > 0
    }
    case 'copilot':
      return existsSync(join(home, '.copilot', 'config.json'))
    case 'qoder-cn':
      return existsSync(join(home, '.qoder-cn', 'settings.json'))
    case 'qoder':
      return existsSync(join(home, '.qoder', 'settings.json'))
    case 'antigravity':
      return existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'))
  }
}

/** A linked worktree at `worktree` whose main checkout is `mainCheckout`, as git lays it out. */
export function linkGitWorktree(mainCheckout: string, worktree: string): void {
  const gitDir = join(mainCheckout, '.git', 'worktrees', 'feature')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), join(worktree, '.git'))
}
