import {
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
  lstatSync(path).isSymbolicLink() ? realpathSync(path) : null

describe("a bot's own skills", () => {
  it('links each skill into both agent folders and leaves what is not its link alone', async () => {
    const home = scratch()
    const outside = scratch()
    const deploy = writeSkill(join(home, 'skills'), 'deploy')
    writeSkill(join(home, 'skills'), 'notes')
    // An older bot's own Claude skill, and a name taken by the owner's link elsewhere.
    writeSkill(join(home, '.claude/skills'), 'legacy')
    symlinkSync(writeSkill(outside, 'notes'), join(home, '.claude/skills/notes'))

    await syncBotOwnSkills(home)

    expect(linkTarget(join(home, '.claude/skills/deploy'))).toBe(deploy)
    expect(linkTarget(join(home, '.agents/skills/deploy'))).toBe(deploy)
    expect(linkTarget(join(home, '.agents/skills/notes'))).toBe(join(home, 'skills/notes'))
    expect(linkTarget(join(home, '.claude/skills/notes'))).toBe(join(outside, 'notes'))
    expect(linkTarget(join(home, '.claude/skills/legacy'))).toBeNull()

    rmSync(deploy, { recursive: true })
    await syncBotOwnSkills(home)
    expect(readdirSync(join(home, '.agents/skills'))).toEqual(['notes'])
    expect(readdirSync(join(home, '.claude/skills')).sort()).toEqual(['legacy', 'notes'])

    expect(await botOwnSkillsView(home)).toEqual({
      skillsDir: join(home, 'skills'),
      skills: [{ name: 'notes', description: 'notes d' }],
      agentOnly: [
        { name: 'legacy', description: 'legacy d', only: 'claude' },
        { name: 'notes', description: 'notes d', only: 'claude' }
      ]
    })
  })

  it('opens the agent folder of an older bot that has no skills/ yet', async () => {
    const home = scratch()
    writeSkill(join(home, '.agents/skills'), 'triage')

    await syncBotOwnSkills(home)

    expect(readdirSync(home).sort()).toEqual(['.agents'])
    expect(await botOwnSkillsView(home)).toEqual({
      skillsDir: join(home, '.agents/skills'),
      skills: [],
      agentOnly: [{ name: 'triage', description: 'triage d', only: 'agents' }]
    })
  })
})
