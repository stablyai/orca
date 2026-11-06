import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceMayOverrideDefaultModel } from './agent-project-model-override'

let root: string

function write(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

async function mayOverride(
  agent: string,
  workspacePath: string,
  accountHomePath: string | null = '/homes/a'
) {
  return (await workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath })).effort
}

describe('workspaceMayOverrideDefaultModel', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-project-model-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('walks from a folder up to its repository root, and no further', async () => {
    const repo = join(root, 'repo')
    const folder = join(repo, 'packages', 'app')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "above-the-repo"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
    write(join(repo, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', folder)).toBe(true)
  })

  it('reads only the folder itself when no repository contains it', async () => {
    const folder = join(root, 'loose')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "parent"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
  })

  it('skips the .codex directory that is the account home itself', async () => {
    const worktree = join(root, 'home-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.codex', 'config.toml'), 'model = "user"\n')
    expect(await mayOverride('codex', worktree, join(worktree, '.codex'))).toBe(false)
  })

  it("leaves the account's model standing for Claude settings that pick only the effort", async () => {
    const worktree = join(root, 'effort-only')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    const picks = () =>
      workspaceMayOverrideDefaultModel({
        agent: 'claude',
        workspacePath: worktree,
        accountHomePath: '/homes/a'
      })
    write(join(worktree, '.claude', 'settings.local.json'), '{"effortLevel":"low"}')
    expect(await picks()).toEqual({ model: false, effort: true })
    write(
      join(worktree, '.claude', 'settings.local.json'),
      '{"modelSettings":{"claude-opus-5-5":{"effortLevel":"high"}}}'
    )
    expect(await picks()).toEqual({ model: false, effort: true })
  })

  it('counts unreadable project config as an override', async () => {
    const worktree = join(root, 'broken')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.claude', 'settings.json'), '{ "model": ')
    write(join(worktree, '.codex', 'config.toml'), 'model = ')
    expect(await mayOverride('claude', worktree)).toBe(true)
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('reads OpenCode config above the repository root too, as OpenCode 2.x does', async () => {
    const repo = join(root, 'oc-above', 'repo')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(root, 'oc-above', 'opencode.json'), '{"model":"x/y"}')
    expect(await mayOverride('opencode', repo, null)).toBe(true)
  })

  // Windows permission bits cannot make this fixture unreadable.
})
