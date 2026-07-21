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

  it('discovers the enabled Claude plugin version applicable to the project cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const project = join(root, 'project')
    const cwd = join(project, 'worktree')
    const userInstall = join(home, '.claude', 'plugins', 'cache', 'compound', '3.13.1')
    const projectInstall = join(home, '.claude', 'plugins', 'cache', 'compound', '3.14.3')
    const pluginId = 'compound-engineering@compound-engineering-plugin'
    await mkdir(join(userInstall, 'skills', 'old-plan'), { recursive: true })
    await mkdir(join(projectInstall, 'skills', 'ce-plan'), { recursive: true })
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(userInstall, 'skills', 'old-plan', 'SKILL.md'), '# old-plan')
    await writeFile(
      join(projectInstall, 'skills', 'ce-plan', 'SKILL.md'),
      '---\nname: ce-plan\ndescription: Create structured plans.\n---\n'
    )
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [pluginId]: [
            { scope: 'user', installPath: userInstall },
            { scope: 'project', projectPath: project, installPath: projectInstall }
          ]
        }
      })
    )
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { [pluginId]: true } })
    )

    const result = await discoverSkills({ homeDir: home, cwd, repos: [] })

    expect(result.skills.map((skill) => skill.name)).toContain('ce-plan')
    expect(result.skills.map((skill) => skill.name)).not.toContain('old-plan')
    const pluginSource = result.sources.find(
      (source) => source.path === join(projectInstall, 'skills')
    )
    expect(pluginSource).toMatchObject({ sourceKind: 'plugin', owner: 'claude', exists: true })
  })

  it('skips Claude plugin discovery when no explicit cwd targets the scan (Settings shape)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const install = join(home, '.claude', 'plugins', 'cache', 'compound', '3.14.3')
    const pluginId = 'compound-engineering@compound-engineering-plugin'
    await mkdir(join(install, 'skills', 'ce-plan'), { recursive: true })
    await writeFile(join(install, 'skills', 'ce-plan', 'SKILL.md'), '# ce-plan')
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [pluginId]: [{ scope: 'user', installPath: install }] } })
    )
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { [pluginId]: true } })
    )

    const result = await discoverSkills({ homeDir: home, repos: [], includeCwd: false })

    expect(result.skills.map((skill) => skill.name)).not.toContain('ce-plan')
    expect(result.sources.some((source) => source.id.startsWith('claude-plugin'))).toBe(false)
  })

  it('records every contributing root when symlinked roots dedup to one skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const codexSkills = join(home, '.codex', 'skills')
    await mkdir(join(codexSkills, 'review'), { recursive: true })
    await writeFile(join(codexSkills, 'review', 'SKILL.md'), '# review')
    await mkdir(join(home, '.agents'), { recursive: true })
    // Shared root is a symlink onto the Codex root: one canonical file, two roots.
    await symlink(codexSkills, join(home, '.agents', 'skills'), 'dir')

    const result = await discoverSkills({ homeDir: home, repos: [], includeCwd: false })

    const reviews = result.skills.filter((skill) => skill.name === 'review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].rootPaths?.slice().sort()).toEqual(
      [codexSkills, join(home, '.agents', 'skills')].sort()
    )
  })

  it('does not add SSH-backed repository paths to local scan roots', () => {
    const roots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current',
      repos: [makeRepo('/remote/repo', 'ssh-1')]
    })

    const rootPaths = roots.map((root) => root.path.replace(/\\/g, '/'))
    expect(rootPaths).not.toContain('/remote/repo/.claude/skills')
    expect(rootPaths).toContain('/workspace/current/.claude/skills')
  })

  it('scans each provider home skill root that npx skills --global writes to', () => {
    const roots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current'
    })

    const rootPaths = roots.map((root) => root.path.replace(/\\/g, '/'))
    expect(rootPaths).toEqual(
      expect.arrayContaining([
        '/home/test/.grok/skills',
        '/home/test/.config/opencode/skills',
        '/home/test/.pi/agent/skills',
        '/home/test/.gemini/skills',
        '/home/test/.gemini/antigravity/skills',
        '/home/test/.cursor/skills'
      ])
    )
    // Why: these live outside ~/.agents/skills, so they must carry the shared
    // agent-skills provider to feed per-agent orchestration coverage.
    for (const root of roots) {
      if (root.path.replace(/\\/g, '/') === '/home/test/.grok/skills') {
        expect(root.providers).toEqual(['agent-skills'])
      }
    }
  })

  it('does not add runtime-owned repository paths to local scan roots', () => {
    const runtimeRepo = makeRepo('/runtime/repo')
    runtimeRepo.executionHostId = 'runtime:environment-1'

    const roots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current',
      repos: [runtimeRepo]
    })

    expect(roots.map((root) => root.path.replace(/\\/g, '/'))).not.toContain(
      '/runtime/repo/.agents/skills'
    )
  })

  it('can exclude the implicit cwd without excluding explicit local repositories', () => {
    const defaultRoots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current',
      repos: [makeRepo('/workspace/known')]
    })
    const explicitRoots = buildSkillDiscoverySources({
      homeDir: '/home/test',
      cwd: '/workspace/current',
      repos: [makeRepo('/workspace/known')],
      includeCwd: false
    })

    const normalizedDefaultPaths = defaultRoots.map((root) => root.path.replace(/\\/g, '/'))
    const normalizedExplicitPaths = explicitRoots.map((root) => root.path.replace(/\\/g, '/'))
    expect(normalizedDefaultPaths).toContain('/workspace/current/.agents/skills')
    expect(normalizedExplicitPaths).not.toContain('/workspace/current/.agents/skills')
    expect(normalizedExplicitPaths).toContain('/workspace/known/.agents/skills')
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

  it('discovers a symlinked skill inside a provider home root (#8256/#8503)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const realSkill = join(root, 'central-skills', 'orchestration')
    const linkedSkill = join(home, '.pi', 'agent', 'skills', 'orchestration')
    await mkdir(realSkill, { recursive: true })
    await mkdir(join(home, '.pi', 'agent', 'skills'), { recursive: true })
    await writeFile(join(realSkill, 'SKILL.md'), '# orchestration\n\nCoordinate agents.')
    await symlink(realSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd')
    })

    const skill = result.skills.find((entry) => entry.name === 'orchestration')
    expect(skill?.sourceKind).toBe('home')
    expect(skill?.directoryPath).toBe(linkedSkill)
    expect(skill?.providers).toEqual(['agent-skills'])
  })

  it('discovers worktree .agents skill symlinks from the requested cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const worktree = join(root, 'worktree')
    const realSkill = join(root, 'central-skills', 'ref-oss')
    const linkedSkill = join(worktree, '.agents', 'skills', 'ref-oss')
    await mkdir(realSkill, { recursive: true })
    await mkdir(join(worktree, '.agents', 'skills'), { recursive: true })
    await writeFile(join(realSkill, 'SKILL.md'), '# ref-oss\n\nUse local OSS reference repos.')
    await symlink(realSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await discoverSkills({
      homeDir: home,
      cwd: worktree,
      repos: []
    })

    expect(result.skills.filter((entry) => entry.name === 'ref-oss')).toMatchObject([
      {
        sourceKind: 'repo',
        sourceLabel: 'Repo worktree .agents',
        directoryPath: linkedSkill,
        providers: ['agent-skills']
      }
    ])
  })

  it('keeps home classification when cwd points at the same directory as home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const skillDir = join(home, '.agents', 'skills', 'orca-cli')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: orca-cli', 'description: Use the Orca CLI.', '---', ''].join('\n')
    )

    const result = await discoverSkills({
      homeDir: home,
      cwd: home,
      repos: []
    })

    expect(result.skills.filter((entry) => entry.name === 'orca-cli')).toMatchObject([
      {
        sourceKind: 'home',
        sourceLabel: 'Agent skills home',
        directoryPath: skillDir
      }
    ])
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
