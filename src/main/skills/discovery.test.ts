import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillDiscoverySources, discoverSkills } from './discovery'
import type { Repo } from '../../shared/types'

function makeRepo(path: string, connectionId: string | null = null): Repo {
  return {
    id: `repo-${path}`,
    path,
    displayName: 'Repo',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId
  }
}

describe('skill discovery', () => {
  it('discovers home and repo SKILL.md packages with provider metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const codexSkill = join(home, '.codex', 'skills', 'review')
    const repoSkill = join(repo, '.claude', 'skills', 'docs')
    await mkdir(codexSkill, { recursive: true })
    await mkdir(repoSkill, { recursive: true })
    await writeFile(
      join(codexSkill, 'SKILL.md'),
      ['---', 'name: code-review', 'description: Review code changes.', '---', ''].join('\n')
    )
    await writeFile(join(repoSkill, 'SKILL.md'), '# Docs\n\nWrite project docs.')

    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd'),
      repos: [makeRepo(repo)]
    })

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['Docs', 'code-review'])
    expect(result.skills.find((skill) => skill.name === 'code-review')?.providers).toEqual([
      'codex'
    ])
    expect(result.skills.find((skill) => skill.name === 'Docs')?.providers).toEqual(['claude'])
  })

  it('does not add SSH-backed repository paths to local scan roots', () => {
    const roots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current',
      repos: [makeRepo('/remote/repo', 'ssh-1')]
    })

    expect(roots.map((root) => root.path)).not.toContain('/remote/repo/.claude/skills')
    expect(roots.map((root) => root.path)).toContain('/workspace/current/.claude/skills')
  })
})
