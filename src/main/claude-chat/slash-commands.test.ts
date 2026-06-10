import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { listSlashCommands } from './slash-commands'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-cmd-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

describe('listSlashCommands', () => {
  it('returns empty when no command dirs exist', async () => {
    const cmds = await listSlashCommands(path.join(tmp, 'proj'), path.join(tmp, 'home'))
    expect(cmds).toEqual([])
  })

  it('lists project and user commands with descriptions', async () => {
    await write('proj/.claude/commands/deploy.md', '---\ndescription: Deploy the app\n---\nBody')
    await write('home/.claude/commands/review.md', 'no frontmatter')
    const cmds = await listSlashCommands(path.join(tmp, 'proj'), path.join(tmp, 'home'))
    expect(cmds).toEqual([
      { name: 'deploy', description: 'Deploy the app', source: 'project' },
      { name: 'review', description: '', source: 'user' }
    ])
  })

  it('namespaces subdirectory commands with a colon', async () => {
    await write('home/.claude/commands/git/push.md', '---\ndescription: Push it\n---')
    const cmds = await listSlashCommands(path.join(tmp, 'proj'), path.join(tmp, 'home'))
    expect(cmds).toEqual([{ name: 'git:push', description: 'Push it', source: 'user' }])
  })

  it('lists skills from SKILL.md and dedupes by name (project wins)', async () => {
    await write('home/.claude/skills/graphify/SKILL.md', '---\ndescription: Graph it\n---')
    await write('proj/.claude/commands/graphify.md', '---\ndescription: Project override\n---')
    const cmds = await listSlashCommands(path.join(tmp, 'proj'), path.join(tmp, 'home'))
    expect(cmds).toEqual([
      { name: 'graphify', description: 'Project override', source: 'project' }
    ])
  })
})
