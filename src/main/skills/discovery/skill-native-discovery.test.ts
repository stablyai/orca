import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSkillRootScanCache, discoverSkills } from './skill-native-discovery'
import { isNativeChatSkillForAgent } from '../../../shared/native-chat/input/commands/native-chat-skill-visibility'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import '../../../shared/agent-launch/catalog/tui-agent-config'

import type * as SkillRootFileWalk from './skill-root-file-walk'

let unavailableRootPath: string | null = null

vi.mock('./skill-root-file-walk', async (importOriginal) => {
  const actual = await importOriginal<typeof SkillRootFileWalk>()
  return {
    ...actual,
    findSkillFiles: (rootPath: string, maxDepth: number, signal?: AbortSignal) => {
      if (unavailableRootPath !== null && rootPath === unavailableRootPath) {
        return Promise.reject(
          Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError'
          })
        )
      }
      return actual.findSkillFiles(rootPath, maxDepth, signal)
    }
  }
})

beforeEach(() => {
  // Reset shared scans because each case owns a different tree.
  clearSkillRootScanCache()
  // HERMES_HOME and Pi agent dir envs can escape the fixture; isolate them from developer installs.
  vi.stubEnv('HERMES_HOME', '')
  vi.stubEnv('LOCALAPPDATA', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('GROK_HOME', '')
  vi.stubEnv('PI_CODING_AGENT_DIR', '')
  vi.stubEnv('ORCA_PI_SOURCE_AGENT_DIR', '')
  vi.stubEnv('ORCA_PI_CODING_AGENT_DIR', '')
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  unavailableRootPath = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('skill discovery', () => {
  // An abandoned root must not empty the picker for healthy roots.
  it('keeps every healthy root when one root walk is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const healthySkill = join(home, '.codex', 'skills', 'review')
    const stalledSkill = join(home, '.omp', 'agent', 'skills', 'planning')
    await mkdir(healthySkill, { recursive: true })
    await mkdir(stalledSkill, { recursive: true })
    await writeFile(join(healthySkill, 'SKILL.md'), '# Review\n\nReview code.')
    await writeFile(join(stalledSkill, 'SKILL.md'), '# Planning\n\nPlan work.')
    unavailableRootPath = join(home, '.omp', 'agent', 'skills')

    const result = await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd') })

    expect(result.skills.map((skill) => skill.name)).toEqual(['Review'])
    const stalledSource = result.sources.find((source) => source.path === unavailableRootPath)
    expect(stalledSource).toMatchObject({ skippedReason: 'unavailable' })
  })

  // Retain the last answered scan so stalled roots do not make installed skills offer Install.
  it('serves the last answered skills for a root whose rescan did not answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const stalledRoot = join(home, '.omp', 'agent', 'skills')
    await mkdir(join(stalledRoot, 'planning'), { recursive: true })
    await writeFile(join(stalledRoot, 'planning', 'SKILL.md'), '# Planning\n\nPlan work.')

    const first = await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd') })
    expect(first.skills.map((skill) => skill.name)).toEqual(['Planning'])

    unavailableRootPath = stalledRoot
    const second = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd'),
      refresh: true
    })

    expect(second.skills.map((skill) => skill.name)).toEqual(['Planning'])
    expect(second.sources.find((source) => source.path === stalledRoot)).toMatchObject({
      skippedReason: 'unavailable'
    })
  })

  it('drops the retained copy once a root answers as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const stalledRoot = join(home, '.omp', 'agent', 'skills')
    await mkdir(join(stalledRoot, 'planning'), { recursive: true })
    await writeFile(join(stalledRoot, 'planning', 'SKILL.md'), '# Planning\n\nPlan work.')
    await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd') })
    await rm(stalledRoot, { recursive: true })

    await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd'), refresh: true })
    unavailableRootPath = stalledRoot
    const result = await discoverSkills({
      homeDir: home,
      cwd: join(root, 'missing-cwd'),
      refresh: true
    })

    expect(result.skills.map((skill) => skill.name)).toEqual([])
  })

  it('filters discovery by requested directory name and source kind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const homeSkill = join(home, '.agents', 'skills', 'orchestration')
    const repoSkill = join(repo, '.agents', 'skills', 'orchestration')
    const unrelatedSkill = join(home, '.agents', 'skills', 'computer-use')
    await mkdir(homeSkill, { recursive: true })
    await mkdir(repoSkill, { recursive: true })
    await mkdir(unrelatedSkill, { recursive: true })
    await writeFile(join(homeSkill, 'SKILL.md'), '---\nname: Agent Orchestration\n---\n')
    await writeFile(join(repoSkill, 'SKILL.md'), '# orchestration')
    await writeFile(join(unrelatedSkill, 'SKILL.md'), '# computer-use')

    const result = await discoverSkills({
      homeDir: home,
      cwd: repo,
      repos: [],
      names: ['orchestration'],
      sourceKinds: ['home']
    })

    expect(result.skills).toMatchObject([
      { name: 'Agent Orchestration', sourceKind: 'home', directoryPath: homeSkill }
    ])
    expect(result.sources.every((source) => source.sourceKind === 'home')).toBe(true)

    const unfiltered = await discoverSkills({
      homeDir: home,
      cwd: repo,
      repos: [],
      sourceKinds: []
    })
    expect(unfiltered.skills.map((skill) => skill.name).sort()).toEqual([
      'Agent Orchestration',
      'computer-use',
      'orchestration'
    ])
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

  it('lists for each chat agent the skills its CLI loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const folders: [string, string][] = [
      [join(home, '.cursor', 'skills'), 'cursor-home'],
      [join(home, '.cursor', 'skills-cursor'), 'cursor-builtin'],
      [join(home, '.copilot', 'skills'), 'copilot-home'],
      [join(home, '.agents', 'skills'), 'agents-home'],
      [join(home, '.claude', 'skills'), 'claude-home'],
      [join(home, '.codex', 'skills'), 'codex-home'],
      [join(home, '.grok', 'skills'), 'grok-home'],
      [join(repo, '.cursor', 'skills'), 'cursor-project'],
      [join(repo, '.github', 'skills'), 'github-project'],
      [join(repo, '.claude', 'skills'), 'claude-project'],
      [join(repo, '.agents', 'skills'), 'agents-project'],
      [join(repo, '.codex', 'skills'), 'codex-project'],
      [join(home, '.codex', 'skills', '.system'), 'codex-bundled'],
      [join(home, '.pi', 'agent', 'skills'), 'pi-only']
    ]
    for (const [folder, name] of folders) {
      await mkdir(join(folder, name), { recursive: true })
      await writeFile(join(folder, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }

    const result = await discoverSkills({ homeDir: home, cwd: repo, repos: [] })
    const visibleTo = (agent: AgentType) =>
      result.skills
        .filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
        .map((skill) => skill.name)
        .sort()

    // Each list is what that CLI loaded from these folders (cursor-agent 2026.11.17,
    // Copilot 1.0.109).
    expect(visibleTo('cursor')).toEqual([
      'agents-home',
      'agents-project',
      'claude-home',
      'claude-project',
      'codex-home',
      'codex-project',
      'cursor-builtin',
      'cursor-home',
      'cursor-project',
      'grok-home'
    ])
    expect(visibleTo('copilot')).toEqual([
      'agents-home',
      'agents-project',
      'claude-project',
      'copilot-home',
      'github-project'
    ])
  })

  it('keeps a relocated Claude or Grok home for its owner and the default one for Cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const folders: [string, string][] = [
      [join(home, '.claude', 'skills'), 'claude-default'],
      [join(root, 'claude-config', 'skills'), 'claude-relocated'],
      [join(home, '.grok', 'skills'), 'grok-default'],
      [join(root, 'grok-home', 'skills'), 'grok-relocated']
    ]
    for (const [folder, name] of folders) {
      await mkdir(join(folder, name), { recursive: true })
      await writeFile(join(folder, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }

    // CLAUDE_CONFIG_DIR and GROK_HOME move their owners' skills; Cursor still joins ~/.claude and ~/.grok.
    const result = await discoverSkills({
      homeDir: home,
      repos: [],
      includeCwd: false,
      providerRootOverrides: {
        claude: join(root, 'claude-config', 'skills'),
        grok: join(root, 'grok-home', 'skills')
      }
    })
    const visibleTo = (agent: AgentType) =>
      result.skills
        .filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
        .map((skill) => skill.name)
        .sort()

    expect(visibleTo('claude')).toEqual(['claude-relocated'])
    expect(visibleTo('grok')).toEqual(['grok-relocated'])
    expect(visibleTo('cursor')).toEqual(['claude-default', 'grok-default'])

    // A workspace at the home folder makes ~/.claude/skills Claude's project folder too.
    const atHome = await discoverSkills({
      homeDir: home,
      cwd: home,
      repos: [],
      providerRootOverrides: { claude: join(root, 'claude-config', 'skills') }
    })
    expect(
      atHome.skills
        .filter((skill) => isNativeChatSkillForAgent('claude', skill, atHome))
        .map((skill) => skill.name)
        .sort()
    ).toEqual(['claude-default', 'claude-relocated'])
  })

  it('scans a relocated Claude home that links to the default one once, for everyone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const defaultSkills = join(home, '.claude', 'skills')
    const accountSkills = join(root, 'account', 'skills')
    await mkdir(join(defaultSkills, 'review'), { recursive: true })
    await writeFile(join(defaultSkills, 'review', 'SKILL.md'), '# review')
    await mkdir(join(root, 'account'), { recursive: true })
    // A managed Claude account links its skills folder to the default one.
    await symlink(defaultSkills, accountSkills, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await discoverSkills({
      homeDir: home,
      repos: [],
      includeCwd: false,
      providerRootOverrides: { claude: accountSkills }
    })

    expect(result.sources.filter((source) => source.owner === 'claude')).toHaveLength(1)
    const review = result.skills.find((skill) => skill.name === 'review')!
    expect(isNativeChatSkillForAgent('claude', review, result)).toBe(true)
    expect(isNativeChatSkillForAgent('cursor', review, result)).toBe(true)
  })

  it('records every contributing root when symlinked roots dedup to one skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const codexSkills = join(home, '.codex', 'skills')
    await mkdir(join(codexSkills, 'review'), { recursive: true })
    await writeFile(join(codexSkills, 'review', 'SKILL.md'), '# review')
    await mkdir(join(home, '.agents'), { recursive: true })
    await symlink(
      codexSkills,
      join(home, '.agents', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const result = await discoverSkills({ homeDir: home, repos: [], includeCwd: false })

    const reviews = result.skills.filter((skill) => skill.name === 'review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].rootPaths?.slice().sort()).toEqual(
      [codexSkills, join(home, '.agents', 'skills')].sort()
    )
  })
  it('discovers Pi skills from git and npm packages in user settings.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const piAgentDir = join(home, '.pi', 'agent')
    const gitPkgRoot = join(piAgentDir, 'git', 'github.com', 'DietrichGebert', 'ponytail')
    const npmSkillsPkgRoot = join(piAgentDir, 'npm', 'node_modules', 'pi-skill-pack')
    const npmExtOnlyPkgRoot = join(piAgentDir, 'npm', 'node_modules', 'pi-simplify')

    await mkdir(join(gitPkgRoot, 'skills', 'ponytail'), { recursive: true })
    await mkdir(join(gitPkgRoot, 'skills', 'ponytail-review'), { recursive: true })
    await mkdir(join(npmSkillsPkgRoot, 'skills', 'quick-fix'), { recursive: true })
    await mkdir(join(npmExtOnlyPkgRoot, 'skills', 'ignored-skill'), { recursive: true })

    await writeFile(
      join(gitPkgRoot, 'package.json'),
      JSON.stringify({
        name: '@dietrichgebert/ponytail',
        pi: { extensions: ['./pi-extension/index.js'], skills: ['./skills'] }
      })
    )
    await writeFile(
      join(gitPkgRoot, 'skills', 'ponytail', 'SKILL.md'),
      '---\nname: ponytail\ndescription: Lazy senior dev mode.\n---\n'
    )
    await writeFile(
      join(gitPkgRoot, 'skills', 'ponytail-review', 'SKILL.md'),
      '---\nname: ponytail-review\ndescription: Quality review.\n---\n'
    )
    await writeFile(
      join(npmSkillsPkgRoot, 'skills', 'quick-fix', 'SKILL.md'),
      '---\nname: quick-fix\ndescription: Apply quick fixes.\n---\n'
    )
    await writeFile(
      join(npmExtOnlyPkgRoot, 'package.json'),
      JSON.stringify({
        name: 'pi-simplify',
        pi: { extensions: ['dist/index.js'] }
      })
    )
    await writeFile(
      join(npmExtOnlyPkgRoot, 'skills', 'ignored-skill', 'SKILL.md'),
      '# ignored-skill\n\nShould not be loaded when pi manifest omits skills.'
    )
    await writeFile(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({
        packages: [
          'git:github.com/DietrichGebert/ponytail',
          'npm:pi-skill-pack@^1.0.0',
          'npm:pi-simplify'
        ]
      })
    )

    const result = await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd') })

    const names = result.skills.map((skill) => skill.name).sort()
    expect(names).toEqual(['ponytail', 'ponytail-review', 'quick-fix'])
    const ponytail = result.skills.find((skill) => skill.name === 'ponytail')
    expect(ponytail).toBeDefined()
    expect(isNativeChatSkillForAgent('pi', ponytail!, result)).toBe(true)
    expect(isNativeChatSkillForAgent('claude', ponytail!, result)).toBe(false)
  })

  it('discovers Pi skills from project .pi/settings.json local packages and .pi/skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const project = join(root, 'project')
    const localPkg = join(project, 'local-pi-pkg')

    await mkdir(join(project, '.pi', 'skills', 'proj-skill'), { recursive: true })
    await mkdir(join(localPkg, 'custom-skills', 'local-pkg-skill'), { recursive: true })
    await writeFile(
      join(project, '.pi', 'skills', 'proj-skill', 'SKILL.md'),
      '---\nname: proj-skill\ndescription: Project Pi skill.\n---\n'
    )
    await writeFile(
      join(localPkg, 'package.json'),
      JSON.stringify({ name: 'local-pi-pkg', pi: { skills: ['./custom-skills'] } })
    )
    await writeFile(
      join(localPkg, 'custom-skills', 'local-pkg-skill', 'SKILL.md'),
      '---\nname: local-pkg-skill\ndescription: Local package skill.\n---\n'
    )
    await writeFile(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({ packages: ['../local-pi-pkg'] })
    )

    const result = await discoverSkills({ homeDir: home, cwd: project, repos: [] })

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'local-pkg-skill',
      'proj-skill'
    ])
    for (const skill of result.skills) {
      expect(isNativeChatSkillForAgent('pi', skill, result)).toBe(true)
    }
  })

  it('respects PI_CODING_AGENT_DIR and ORCA_PI_SOURCE_AGENT_DIR and deduplicates symlinked skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const customPiDir = join(root, 'custom-pi')
    const sourcePiDir = join(root, 'source-pi')
    const gitPkgSkills = join(sourcePiDir, 'git', 'github.com', 'org', 'pkg', 'skills')

    await mkdir(join(gitPkgSkills, 'shared-skill'), { recursive: true })
    await mkdir(join(sourcePiDir, 'skills'), { recursive: true })
    await writeFile(
      join(gitPkgSkills, 'shared-skill', 'SKILL.md'),
      '---\nname: shared-skill\ndescription: Shared skill.\n---\n'
    )
    await symlink(
      join(gitPkgSkills, 'shared-skill'),
      join(sourcePiDir, 'skills', 'shared-skill'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await writeFile(
      join(sourcePiDir, 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/org/pkg'] })
    )

    vi.stubEnv('PI_CODING_AGENT_DIR', customPiDir)
    vi.stubEnv('ORCA_PI_SOURCE_AGENT_DIR', sourcePiDir)

    const result = await discoverSkills({ homeDir: home, cwd: join(root, 'missing-cwd') })

    const shared = result.skills.filter((skill) => skill.name === 'shared-skill')
    expect(shared).toHaveLength(1)
    expect(shared[0].rootPaths?.slice().sort()).toEqual(
      [join(sourcePiDir, 'skills'), gitPkgSkills].sort()
    )
  })
})
