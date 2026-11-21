import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { botOwnSkillsView, linkBotOwnSkills } from './bot-own-skills'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bot-own-skills-')))
  dirs.push(dir)
  return dir
}

function writeSkill(folder: string, name: string): string {
  mkdirSync(join(folder, name), { recursive: true })
  writeFileSync(join(folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} d\n---\n`)
  return join(folder, name)
}

const linkTarget = (path: string): string | null =>
  lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : null

describe("a bot's own skills", () => {
  it('links each skill into both agent folders and removes nothing when it goes', async () => {
    const home = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    await linkBotOwnSkills(home)

    expect(linkTarget(join(home, '.claude/skills/deploy'))).toBe(deploy)
    expect(linkTarget(join(home, '.agents/skills/deploy'))).toBe(deploy)

    rmSync(deploy, { recursive: true })
    await linkBotOwnSkills(home)
    expect(lstatSync(join(home, '.claude/skills/deploy')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, '.agents/skills/deploy')).isSymbolicLink()).toBe(true)
  })

  it('leaves whatever already holds a name as it is', async () => {
    const home = scratch()
    const outside = scratch()
    for (const name of ['file', 'folder', 'link', 'dangling', 'alias-target']) {
      writeSkill(join(home, 'skills'), name)
    }
    mkdirSync(join(home, '.claude/skills/folder'), { recursive: true })
    writeFileSync(join(home, '.claude/skills/file'), 'mine\n')
    symlinkSync(writeSkill(outside, 'mine'), join(home, '.claude/skills/link'))
    symlinkSync(join(outside, 'gone'), join(home, '.claude/skills/dangling'))

    await linkBotOwnSkills(home)

    expect(readFileSync(join(home, '.claude/skills/file'), 'utf8')).toBe('mine\n')
    expect(lstatSync(join(home, '.claude/skills/folder')).isDirectory()).toBe(true)
    expect(readdirSync(join(home, '.claude/skills/folder'))).toEqual([])
    expect(linkTarget(join(home, '.claude/skills/link'))).toBe(join(outside, 'mine'))
    expect(readlinkSync(join(home, '.claude/skills/dangling'))).toBe(join(outside, 'gone'))
    expect(linkTarget(join(home, '.claude/skills/alias-target'))).toBe(
      join(home, 'skills/alias-target')
    )
  })

  it('links nothing that leads out of the home', async () => {
    const home = scratch()
    const outside = scratch()
    mkdirSync(join(home, 'skills'))
    symlinkSync(writeSkill(outside, 'external'), join(home, 'skills/external'))
    await linkBotOwnSkills(home)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect((await botOwnSkillsView(home)).skills).toEqual([])

    const linkedRoot = scratch()
    writeSkill(join(outside, 'root'), 'elsewhere')
    symlinkSync(join(outside, 'root'), join(linkedRoot, 'skills'))
    await linkBotOwnSkills(linkedRoot)
    expect(existsSync(join(linkedRoot, '.claude'))).toBe(false)
  })

  it('shows a skill both agent folders reach once, loaded by both', async () => {
    const home = scratch()
    const triage = writeSkill(join(home, '.agents/skills'), 'triage')
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    symlinkSync(triage, join(home, '.claude/skills/triage'))
    writeSkill(join(home, '.claude/skills'), 'tone')

    expect(await botOwnSkillsView(home)).toEqual({
      skillsDir: join(home, '.claude/skills'),
      skills: [],
      agentOnly: [
        {
          name: 'tone',
          description: 'tone d',
          folder: join(home, '.claude/skills/tone'),
          loadedBy: ['claude']
        },
        { name: 'triage', description: 'triage d', folder: triage, loadedBy: ['claude', 'agents'] }
      ]
    })
  })

  it('labels each skill by the agent folders that actually reach it', async () => {
    const home = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    const blocked = writeSkill(join(home, 'skills'), 'blocked')
    const nested = writeSkill(join(home, 'skills/archive'), 'old')
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    mkdirSync(join(home, '.agents/skills'), { recursive: true })
    writeFileSync(join(home, '.claude/skills/deploy'), 'mine\n')
    writeFileSync(join(home, '.claude/skills/blocked'), 'mine\n')
    writeFileSync(join(home, '.agents/skills/blocked'), 'mine\n')
    symlinkSync(nested, join(home, '.claude/skills/old'))

    await linkBotOwnSkills(home)
    const view = await botOwnSkillsView(home)

    expect(view.skills.map(({ name, folder, loadedBy }) => ({ name, folder, loadedBy }))).toEqual([
      { name: 'blocked', folder: blocked, loadedBy: [] },
      { name: 'deploy', folder: deploy, loadedBy: ['agents'] }
    ])
    expect(view.agentOnly).toEqual([
      { name: 'old', description: 'old d', folder: nested, loadedBy: ['claude'] }
    ])
  })
})
