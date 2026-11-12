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
  agent: string,
  workspacePath: string,
  accountHomePath: string | null = '/homes/a'
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

  it('walks from a folder up to its repository root, and no further', async () => {
    const repo = join(root, 'repo')
    const folder = join(repo, 'packages', 'app')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.pi', 'settings.json'), '{"defaultModel":"above-the-repo"}')
    expect(await mayOverride('pi', folder)).toBe(false)
    write(join(repo, '.pi', 'settings.json'), '{"defaultModel":"project"}')
    expect(await mayOverride('pi', folder)).toBe(true)
  })

  it('reads only the folder itself when no repository contains it', async () => {
    const folder = join(root, 'loose')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.pi', 'settings.json'), '{"defaultModel":"parent"}')
    expect(await mayOverride('pi', folder)).toBe(false)
  })

  it('skips the .pi directory that is the account home itself', async () => {
    const worktree = join(root, 'home-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.pi', 'settings.json'), '{"defaultModel":"user"}')
    expect(await mayOverride('pi', worktree, join(worktree, '.pi'))).toBe(false)
  })

  it('counts unreadable project config as an override', async () => {
    const worktree = join(root, 'broken')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.pi', 'settings.json'), '{ "defaultModel": ')
    expect(await mayOverride('pi', worktree)).toBe(true)
  })

  it('reads OpenCode config above the repository root too, as OpenCode 2.x does', async () => {
    const repo = join(root, 'oc-above', 'repo')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(root, 'oc-above', 'opencode.json'), '{"model":"x/y"}')
    expect(await mayOverride('opencode', repo, null)).toBe(true)
  })

  // Windows permission bits cannot make this fixture unreadable.
})
