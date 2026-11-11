import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentConfigHomes } from '../agent-config-roots'
import { readLocalAgentConfig } from './local-agent-config-read'

let dir: string
let homes: AgentConfigHomes

function put(path: string, text: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode) {
    chmodSync(path, mode)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-config-read-'))
  homes = {
    home: join(dir, 'home'),
    claudeDir: join(dir, 'home', '.claude'),
    codexDir: join(dir, 'home', '.codex')
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (repoPath: string | null = null, tracked: string[] | null = []) =>
  readLocalAgentConfig({
    homes,
    repoPath,
    trackedPaths: async () => (tracked ? new Set(tracked) : null)
  })

describe('readLocalAgentConfig', () => {
  it('reads skills with their files and keeps likely secrets on this computer', async () => {
    const skill = join(homes.claudeDir, 'skills', 'deploy')
    put(join(skill, 'SKILL.md'), '---\nname: deploy\n---\nShip it.')
    put(join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 0o755)
    put(join(skill, 'service-account.json'), '{}')
    put(join(skill, 'notes.txt'), 'token: ghp_0123456789abcdefghijABCDEFGHIJ0123456789')
    put(join(skill, '.env'), 'X=1')
    put(join(skill, 'node_modules', 'x', 'index.js'), 'x')
    // Not a skill: no SKILL.md.
    put(join(homes.claudeDir, 'skills', 'synced', 'blob.bin'), 'x')
    // A link out of the skill folder is not followed.
    put(join(dir, 'outside.txt'), 'outside')
    symlinkSync(join(dir, 'outside.txt'), join(skill, 'link.txt'))

    const items = await read()
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({
      scope: 'user',
      kind: 'claude-skill',
      name: 'deploy',
      withheldFiles: 2
    })
    expect(item.skipReason).toBeUndefined()
    expect(item.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/run.sh', true]
    ])
    expect(item.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('skips a skill whose SKILL.md holds a key, and one that is too large', async () => {
    put(
      join(homes.claudeDir, 'skills', 'leaky', 'SKILL.md'),
      'Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    )
    put(join(homes.claudeDir, 'skills', 'huge', 'SKILL.md'), 'x')
    put(join(homes.claudeDir, 'skills', 'huge', 'data.bin'), Buffer.alloc(300 * 1024))
    const items = await read()
    expect(Object.fromEntries(items.map((item) => [item.name, item.skipReason]))).toEqual({
      leaky: 'secret',
      huge: 'too-large'
    })
    expect(items.every((item) => item.files.length === 0)).toBe(true)
  })

  it('reads namespaced Claude commands, flat Codex prompts, and both Codex skill folders', async () => {
    put(join(homes.claudeDir, 'commands', 'review.md'), 'Review $ARGUMENTS')
    put(join(homes.claudeDir, 'commands', 'frontend', 'component.md'), 'Make a component')
    put(join(homes.claudeDir, 'commands', 'README.txt'), 'not a command')
    put(join(homes.codexDir, 'prompts', 'fix.md'), 'Fix it')
    put(join(homes.codexDir, 'prompts', 'nested', 'ignored.md'), 'Codex prompts are flat')
    put(join(homes.home, '.agents', 'skills', 'lint', 'SKILL.md'), 'Lint')
    put(join(homes.codexDir, 'skills', '.system', 'builtin', 'SKILL.md'), 'Codex own')
    put(join(homes.codexDir, 'skills', 'legacy', 'SKILL.md'), 'Old home')
    const items = await read()
    expect(items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
      'agents-skill:lint',
      'claude-command:frontend/component',
      'claude-command:review',
      'codex-prompt:fix',
      'codex-skill:legacy'
    ])
    const review = items.find((item) => item.name === 'review')
    expect(review?.files).toEqual([
      { path: '.', executable: false, bytes: Buffer.from('Review $ARGUMENTS') }
    ])
  })

  it('sends project items git does not track, and marks committed ones as already in the repo', async () => {
    const repo = join(dir, 'repo')
    put(join(repo, '.claude', 'skills', 'committed', 'SKILL.md'), 'in git')
    put(join(repo, '.claude', 'skills', 'local-only', 'SKILL.md'), 'not in git')
    put(join(repo, '.claude', 'commands', 'ship.md'), 'in git')
    put(join(repo, '.claude', 'commands', 'mine.md'), 'not in git')
    const items = await read(repo, [
      '.claude/skills/committed/SKILL.md',
      '.claude/commands/ship.md'
    ])
    expect(
      Object.fromEntries(
        items.map((item) => [`${item.scope}:${item.name}`, item.skipReason ?? 'send'])
      )
    ).toEqual({
      'project:committed': 'in-repo',
      'project:local-only': 'send',
      'project:ship': 'in-repo',
      'project:mine': 'send'
    })
  })

  it('treats project items as committed when git cannot answer', async () => {
    const repo = join(dir, 'repo')
    put(join(repo, '.claude', 'skills', 'a', 'SKILL.md'), 'x')
    const items = await read(repo, null)
    expect(items.map((item) => item.skipReason)).toEqual(['in-repo'])
  })
})
