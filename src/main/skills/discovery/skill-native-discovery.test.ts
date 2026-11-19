import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSkillRootScanCache, discoverSkills } from './skill-native-discovery'
import { isNativeChatSkillForAgent } from '../../../shared/native-chat/input/commands/native-chat-skill-visibility'
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
  // HERMES_HOME can escape the fixture; isolate it from developer installs.
  vi.stubEnv('HERMES_HOME', '')
  vi.stubEnv('LOCALAPPDATA', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('GROK_HOME', '')
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

  it("lists the skills Cursor's chat loads from its own and compatibility folders", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const folders: [string, string][] = [
      [join(home, '.cursor', 'skills'), 'cursor-home'],
      [join(home, '.agents', 'skills'), 'agents-home'],
      [join(home, '.claude', 'skills'), 'claude-home'],
      [join(home, '.codex', 'skills'), 'codex-home'],
      [join(home, '.grok', 'skills'), 'grok-home'],
      [join(repo, '.cursor', 'skills'), 'cursor-project'],
      [join(repo, '.codex', 'skills'), 'codex-project'],
      [join(home, '.codex', 'skills', '.system'), 'codex-bundled'],
      [join(home, '.pi', 'agent', 'skills'), 'pi-only']
    ]
    for (const [folder, name] of folders) {
      await mkdir(join(folder, name), { recursive: true })
      await writeFile(join(folder, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }

    const result = await discoverSkills({ homeDir: home, cwd: repo, repos: [] })

    expect(
      result.skills
        .filter((skill) => isNativeChatSkillForAgent('cursor', skill, result))
        .map((skill) => skill.name)
        .sort()
    ).toEqual([
      'agents-home',
      'claude-home',
      'codex-home',
      'codex-project',
      'cursor-home',
      'cursor-project',
      'grok-home'
    ])
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
})
