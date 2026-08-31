import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCustomSlashCommandRoots,
  clearCustomSlashCommandScanCache,
  discoverCustomSlashCommands
} from './custom-slash-command-discovery'

async function writeCommand(
  root: string,
  relativePath: string,
  contents = '# body\n'
): Promise<void> {
  const filePath = join(root, ...relativePath.split('/'))
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, contents)
}

async function buildFixture(): Promise<{ home: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-slash-commands-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  return { home, cwd }
}

afterEach(() => {
  clearCustomSlashCommandScanCache()
})

describe('buildCustomSlashCommandRoots', () => {
  it('scans the workspace and the home profile', () => {
    const roots = buildCustomSlashCommandRoots({ homeDir: '/home/u', cwd: '/repo' })
    expect(roots).toEqual([
      { path: join('/repo', '.claude', 'commands'), scope: 'project' },
      { path: join('/home/u', '.claude', 'commands'), scope: 'user' }
    ])
  })

  it('scans one root once when the workspace is the home directory', () => {
    expect(buildCustomSlashCommandRoots({ homeDir: '/home/u', cwd: '/home/u' })).toHaveLength(1)
  })
})

describe('discoverCustomSlashCommands', () => {
  it('namespaces nested files and reads the frontmatter description', async () => {
    const { home, cwd } = await buildFixture()
    await writeCommand(
      join(cwd, '.claude', 'commands'),
      'opsx/apply.md',
      '---\ndescription: Apply an OpenSpec change\n---\n\nBody\n'
    )
    await writeCommand(join(cwd, '.claude', 'commands'), 'standalone.md')
    const commands = await discoverCustomSlashCommands({ homeDir: home, cwd })
    expect(commands.map((command) => command.name)).toEqual(['opsx:apply', 'standalone'])
    expect(commands[0]).toMatchObject({
      description: 'Apply an OpenSpec change',
      scope: 'project'
    })
  })

  it('includes user-level commands and lets the project shadow them', async () => {
    const { home, cwd } = await buildFixture()
    await writeCommand(
      join(home, '.claude', 'commands'),
      'shared.md',
      '---\ndescription: user\n---\n'
    )
    await writeCommand(join(home, '.claude', 'commands'), 'only-user.md')
    await writeCommand(
      join(cwd, '.claude', 'commands'),
      'shared.md',
      '---\ndescription: project\n---\n'
    )
    const commands = await discoverCustomSlashCommands({ homeDir: home, cwd })
    expect(commands.map((command) => command.name)).toEqual(['only-user', 'shared'])
    expect(commands.find((command) => command.name === 'shared')).toMatchObject({
      description: 'project',
      scope: 'project'
    })
  })

  it('ignores non-markdown files and skill roots', async () => {
    const { home, cwd } = await buildFixture()
    await writeCommand(join(cwd, '.claude', 'commands'), 'notes.txt')
    await writeCommand(join(cwd, '.claude', 'skills', 'thing'), 'SKILL.md')
    expect(await discoverCustomSlashCommands({ homeDir: home, cwd })).toEqual([])
  })

  it('returns nothing when no commands root exists', async () => {
    const { home, cwd } = await buildFixture()
    expect(await discoverCustomSlashCommands({ homeDir: home, cwd })).toEqual([])
  })

  it('follows a symlinked commands directory', async () => {
    const { home, cwd } = await buildFixture()
    const shared = join(home, 'shared-commands')
    await writeCommand(shared, 'linked.md')
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
    await symlink(shared, join(cwd, '.claude', 'commands', 'team'), 'dir')
    const commands = await discoverCustomSlashCommands({ homeDir: home, cwd })
    expect(commands.map((command) => command.name)).toEqual(['team:linked'])
  })
})
