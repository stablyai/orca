import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
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

  it('discovers skill packages through symlinked skill directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const realSkill = join(root, 'central-skills', 'orca-cli')
    const linkedSkill = join(home, '.agents', 'skills', 'orca-cli')
    await mkdir(realSkill, { recursive: true })
    await mkdir(join(home, '.agents', 'skills'), { recursive: true })
    await writeFile(join(realSkill, 'SKILL.md'), '# Orca CLI\n\nUse the Orca CLI.')
    await symlink(realSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd')
    })

    const skill = result.skills.find((entry) => entry.name === 'Orca CLI')
    expect(skill?.sourceKind).toBe('home')
    expect(skill?.directoryPath).toBe(linkedSkill)
  })

  it('does not loop through recursive symlinked skill directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const skillRoot = join(home, '.agents', 'skills')
    await mkdir(skillRoot, { recursive: true })
    await symlink(
      skillRoot,
      join(skillRoot, 'loop'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd')
    })

    expect(result.skills).toEqual([])
  })

  it('enforces depth limits for valid child directories whose names start with dot-dot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const deepSkill = join(home, '.agents', 'skills', '..deep', 'a', 'b', 'c', 'd', 'too-deep')
    await mkdir(deepSkill, { recursive: true })
    await writeFile(join(deepSkill, 'SKILL.md'), '# Too Deep\n\nShould not be discovered.')

    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd')
    })

    expect(result.skills.map((skill) => skill.name)).not.toContain('Too Deep')
  })
})
