import {
  existsSync,
  lstatSync,
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
import { botOwnSkillsView, syncBotOwnSkills } from './bot-own-skills'

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
  it('links each skill into both agent folders and removes only the links it made', async () => {
    const home = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    await syncBotOwnSkills(home)

    expect(linkTarget(join(home, '.claude/skills/deploy'))).toBe(deploy)
    expect(linkTarget(join(home, '.agents/skills/deploy'))).toBe(deploy)

    rmSync(deploy, { recursive: true })
    await syncBotOwnSkills(home)
    expect(readdirSync(join(home, '.claude/skills'))).toEqual([])
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([])
  })

  it('never removes or takes over a link the owner made, even one into skills/', async () => {
    const home = scratch()
    const outside = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    writeSkill(join(home, 'skills'), 'notes')
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    mkdirSync(join(home, '.agents/skills'), { recursive: true })
    symlinkSync(deploy, join(home, '.claude/skills/personal-deploy'))
    symlinkSync(deploy, join(home, '.agents/skills/deploy'))
    symlinkSync(writeSkill(outside, 'notes'), join(home, '.claude/skills/notes'))
    writeSkill(join(home, '.claude/skills'), 'legacy')

    await syncBotOwnSkills(home)
    rmSync(deploy, { recursive: true })
    await syncBotOwnSkills(home)

    // The owner's alias and same-name link stay, though their skill is gone.
    expect(lstatSync(join(home, '.claude/skills/personal-deploy')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, '.agents/skills/deploy')).isSymbolicLink()).toBe(true)
    expect(linkTarget(join(home, '.claude/skills/notes'))).toBe(join(outside, 'notes'))
    expect(lstatSync(join(home, '.claude/skills/legacy')).isDirectory()).toBe(true)
    expect(linkTarget(join(home, '.agents/skills/notes'))).toBe(join(home, 'skills/notes'))
    expect(existsSync(join(home, '.claude/skills/deploy'))).toBe(false)
  })

  it('leaves a link it made alone once the owner points it somewhere else', async () => {
    const home = scratch()
    const outside = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    await syncBotOwnSkills(home)
    rmSync(join(home, '.claude/skills/deploy'))
    symlinkSync(writeSkill(outside, 'mine'), join(home, '.claude/skills/deploy'))

    rmSync(deploy, { recursive: true })
    await syncBotOwnSkills(home)

    expect(linkTarget(join(home, '.claude/skills/deploy'))).toBe(join(outside, 'mine'))
  })

  it('links nothing that leads out of the home', async () => {
    const home = scratch()
    const outside = scratch()
    mkdirSync(join(home, 'skills'))
    symlinkSync(writeSkill(outside, 'external'), join(home, 'skills/external'))
    await syncBotOwnSkills(home)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect((await botOwnSkillsView(home)).skills).toEqual([])

    const linkedRoot = scratch()
    writeSkill(join(outside, 'root'), 'elsewhere')
    symlinkSync(join(outside, 'root'), join(linkedRoot, 'skills'))
    await syncBotOwnSkills(linkedRoot)
    expect(existsSync(join(linkedRoot, '.claude'))).toBe(false)
  })

  it('lists an older bot’s agent-only skills and opens their folder', async () => {
    const home = scratch()
    writeSkill(join(home, '.agents/skills'), 'triage')

    await syncBotOwnSkills(home)

    expect(await botOwnSkillsView(home)).toEqual({
      skillsDir: join(home, '.agents/skills'),
      skills: [],
      agentOnly: [{ name: 'triage', description: 'triage d', only: 'agents' }]
    })
  })
})
