import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'
import { linkedSkillsSection } from '../native-chat/native-chat-skill-roots'
import { botSkillProjectViews, linkedSkillProjects } from './bot-skill-projects'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bot-skill-projects-')))
  dirs.push(dir)
  return dir
}

function writeSkill(folder: string, name: string): string {
  mkdirSync(join(folder, name), { recursive: true })
  writeFileSync(
    join(folder, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} things\n---\nBody\n`
  )
  return join(folder, name)
}

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 0, ...extra }
}

/** What Orca's folder for a project holds. */
function contentsOf(folder: string): Record<string, string[]> {
  return {
    top: readdirSync(folder).sort(),
    skills: readdirSync(join(folder, 'skills')).sort(),
    claude: readdirSync(join(folder, '.claude')).sort(),
    claudeSkills: readdirSync(join(folder, '.claude', 'skills')).sort()
  }
}

describe('linked projects for bot skills', () => {
  it('counts skill folders a setup script linked in and loads them from a skill-only folder', async () => {
    const base = scratch()
    const electron = writeSkill(join(base, 'devex'), 'electron')
    const perf = writeSkill(join(base, 'devex'), 'perf')
    const project = join(base, 'orca')
    mkdirSync(join(project, '.agents', 'skills'), { recursive: true })
    symlinkSync(electron, join(project, '.agents', 'skills', 'electron'))
    symlinkSync(perf, join(project, '.agents', 'skills', 'perf'))
    // Project config Claude would import from an added project folder.
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.json'), '{"enabledPlugins":{"x@y":true}}')

    const { root, projects } = await linkedSkillProjects(
      { skillProjects: ['orca'] },
      [repo('orca', project)],
      join(base, 'bot')
    )
    const linked = projects[0]

    expect(linked?.skills).toEqual([
      { name: 'electron', description: 'electron things', skillFile: join(electron, 'SKILL.md') },
      { name: 'perf', description: 'perf things', skillFile: join(perf, 'SKILL.md') }
    ])
    expect(root).toEqual({
      skillsRoot: join(base, 'bot', 'skills'),
      pluginDir: join(base, 'bot'),
      linksOut: true
    })
    expect(contentsOf(join(base, 'bot'))).toEqual({
      top: ['.claude', 'skills'],
      skills: ['electron', 'perf'],
      claude: ['skills'],
      claudeSkills: ['electron', 'perf']
    })
    expect(realpathSync(join(base, 'bot', 'skills', 'perf'))).toBe(perf)
  })

  it('never takes a SKILL.md that links to another file, or text without a declared name and description', async () => {
    const base = scratch()
    mkdirSync(join(base, 'elsewhere'))
    const privateFile = join(base, 'elsewhere', 'notes.txt')
    writeFileSync(
      privateFile,
      '---\nname: innocent\ndescription: FAKE_PRIVATE_TOKEN=pretend\n---\nFAKE_PRIVATE_TOKEN=pretend\n'
    )
    const skills = join(base, 'project', '.agents', 'skills')
    mkdirSync(join(skills, 'innocent'), { recursive: true })
    symlinkSync(privateFile, join(skills, 'innocent', 'SKILL.md'))
    mkdirSync(join(skills, 'plain-text'))
    writeFileSync(join(skills, 'plain-text', 'SKILL.md'), 'FAKE_PRIVATE_TOKEN=pretend\n')
    writeSkill(skills, 'deploy')

    const { projects } = await linkedSkillProjects(
      { skillProjects: ['p'] },
      [repo('p', join(base, 'project'))],
      join(base, 'bot')
    )

    expect(projects[0]?.skills.map((skill) => skill.name)).toEqual(['deploy'])
    expect(linkedSkillsSection(projects, projects)).not.toContain('FAKE_PRIVATE_TOKEN')
    expect(readdirSync(join(base, 'bot', 'skills'))).toEqual(['deploy'])
  })

  it('reads a skills folder that is itself a link', async () => {
    const base = scratch()
    writeSkill(join(base, 'shared'), 'review')
    const project = join(base, 'project')
    mkdirSync(join(project, '.agents'), { recursive: true })
    symlinkSync(join(base, 'shared'), join(project, '.agents', 'skills'))

    const { projects } = await linkedSkillProjects(
      { skillProjects: ['p'] },
      [repo('p', project)],
      join(base, 'bot')
    )

    expect(projects[0]?.skills.map((skill) => skill.name)).toEqual(['review'])
  })

  it('loads only the catalog it lists: .agents/skills, else .claude/skills', async () => {
    const base = scratch()
    const both = join(base, 'both')
    writeSkill(join(both, '.agents', 'skills'), 'deploy')
    writeSkill(join(both, '.claude', 'skills'), 'review')
    const claudeOnly = join(base, 'claude-only')
    writeSkill(join(claudeOnly, '.claude', 'skills'), 'review')

    const {
      projects: [first, second]
    } = await linkedSkillProjects(
      { skillProjects: ['both', 'claude-only'] },
      [repo('both', both), repo('claude-only', claudeOnly)],
      join(base, 'bot')
    )

    expect(first?.skills.map((skill) => skill.name)).toEqual(['deploy'])
    expect(second?.skills.map((skill) => skill.name)).toEqual(['review'])
    expect(contentsOf(join(base, 'bot')).claudeSkills).toEqual(['deploy', 'review'])
  })

  it('shows a project with no skills yet, and loads nothing from it', async () => {
    const base = scratch()
    const project = join(base, 'website')
    mkdirSync(join(project, '.agents', 'skills'), { recursive: true })
    const repos = [repo('website', project)]

    await expect(botSkillProjectViews(['website'], repos)).resolves.toEqual([
      { repoId: 'website', name: 'website', status: 'local', skillsDir: null, skills: [] }
    ])
    await expect(
      linkedSkillProjects({ skillProjects: ['website'] }, repos, join(base, 'bot'))
    ).resolves.toMatchObject({ projects: [] })
  })

  it('marks a project on an SSH host as not loadable and never reads its path here', async () => {
    const base = scratch()
    writeSkill(join(base, '.agents', 'skills'), 'deploy')
    // The same path exists here, so only the host decides.
    const repos = [repo('api', base, { connectionId: 'gpu-box' })]

    await expect(botSkillProjectViews(['api', 'gone'], repos)).resolves.toEqual([
      { repoId: 'api', name: 'api', status: 'remote', skillsDir: null, skills: [] },
      { repoId: 'gone', name: 'gone', status: 'missing', skillsDir: null, skills: [] }
    ])
    await expect(
      linkedSkillProjects({ skillProjects: ['api'] }, repos, join(base, 'bot'))
    ).resolves.toMatchObject({ projects: [] })
  })

  it("keeps the bot's one folder current in place as projects are linked and unlinked", async () => {
    const base = scratch()
    const orca = join(base, 'orca')
    const deploy = writeSkill(join(orca, '.agents', 'skills'), 'deploy')
    const website = join(base, 'website')
    const review = writeSkill(join(website, '.agents', 'skills'), 'review')
    const repos = [repo('orca', orca), repo('website', website)]
    const folder = join(base, 'bot')

    await linkedSkillProjects({}, repos, folder)
    expect(contentsOf(folder)).toEqual({
      top: ['.claude', 'skills'],
      skills: [],
      claude: ['skills'],
      claudeSkills: []
    })
    await linkedSkillProjects({ skillProjects: ['orca', 'website'] }, repos, folder)
    expect(contentsOf(folder).claudeSkills).toEqual(['deploy', 'review'])
    await linkedSkillProjects({ skillProjects: ['website'] }, repos, folder)
    expect(contentsOf(folder).skills).toEqual(['review'])
    expect(contentsOf(folder).claudeSkills).toEqual(['review'])
    expect(realpathSync(join(folder, 'skills', 'review'))).toBe(review)
    expect(realpathSync(deploy)).toBe(deploy)
  })

  it('lands links in the order they were asked for, even when the older scan is slower', async () => {
    const base = scratch()
    const big = join(base, 'big')
    for (let index = 0; index < 40; index += 1) {
      writeSkill(join(big, '.agents', 'skills'), `skill-${index}`)
    }
    const folder = join(base, 'bot')

    // The older request scans 40 skills; the newer one, after an unlink, scans none.
    const older = linkedSkillProjects({ skillProjects: ['big'] }, [repo('big', big)], folder)
    const newer = linkedSkillProjects({ skillProjects: [] }, [repo('big', big)], folder)
    await Promise.all([older, newer])

    expect(contentsOf(folder).skills).toEqual([])
  })

  it("links two projects' skills whose folder names differ only in case", async () => {
    const base = scratch()
    const ship = writeSkill(join(base, 'one', '.agents', 'skills'), 'deploy')
    const review = join(base, 'two', '.agents', 'skills', 'Deploy')
    mkdirSync(review, { recursive: true })
    writeFileSync(join(review, 'SKILL.md'), '---\nname: review\ndescription: review things\n---\n')
    const folder = join(base, 'bot')

    await linkedSkillProjects(
      { skillProjects: ['one', 'two'] },
      [repo('one', join(base, 'one')), repo('two', join(base, 'two'))],
      folder
    )

    expect(contentsOf(folder).skills).toEqual(['Deploy-2', 'deploy'])
    expect(realpathSync(join(folder, 'skills', 'deploy'))).toBe(ship)
    expect(realpathSync(join(folder, 'skills', 'Deploy-2'))).toBe(review)
  })

  it("fails, rather than reporting it linked, when something else holds a skill's name", async () => {
    const base = scratch()
    writeSkill(join(base, 'orca', '.agents', 'skills'), 'alpha')
    const folder = join(base, 'bot')
    mkdirSync(join(folder, 'skills', 'alpha'), { recursive: true })

    await expect(
      linkedSkillProjects({ skillProjects: ['orca'] }, [repo('orca', join(base, 'orca'))], folder)
    ).rejects.toThrow(/EEXIST/)
  })
})
