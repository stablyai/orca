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

function mayOverride(
  agent: 'claude' | 'codex',
  workspacePath: string,
  accountHomePath = '/homes/a'
) {
  return workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath })
}

describe('workspaceMayOverrideDefaultModel', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-project-model-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a Codex project config at a linked worktree root', async () => {
    const worktree = join(root, 'wt')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('codex', worktree)).toBe(false)
    write(join(worktree, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', worktree)).toBe(true)
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

  it('never vouches for a Claude default, whose user settings can pick the model', async () => {
    expect(await mayOverride('claude', join(root, 'anywhere'))).toBe(true)
  })
})
