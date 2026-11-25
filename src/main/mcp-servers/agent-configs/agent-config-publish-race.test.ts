import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import { readAgentConfigText, writeAgentConfigIfUnchanged } from './agent-config-file-write'
import { discoverAgentMcpServers } from './agent-mcp-config-read'
import { removeAgentMcpServerEntries } from './agent-mcp-config-removal'

// `save` runs once, just before anything is published at `at` (a rename, a link or a copy).
type Race = { at: string | null; save: () => void; noLinks: boolean }
const race = vi.hoisted((): Race => ({ at: null, save: () => {}, noLinks: false }))
const beforePublishTo = (destination: unknown): void => {
  if (destination === race.at) {
    race.at = null
    race.save()
  }
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      beforePublishTo(destination)
      return actual.rename(source, destination)
    },
    link: async (source: string, destination: string) => {
      if (race.noLinks) {
        throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
      }
      beforePublishTo(destination)
      return actual.link(source, destination)
    },
    copyFile: async (source: string, destination: string, mode?: number) => {
      beforePublishTo(destination)
      return actual.copyFile(source, destination, mode)
    }
  }
})

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-mcp-publish-race-'))
})

afterEach(() => {
  race.at = null
  race.noLinks = false
  rmSync(home, { recursive: true, force: true })
})

async function codexGithub(): Promise<{
  config: string
  server: string
  remove: () => Promise<string[]>
}> {
  const config = join(home, '.codex', 'config.toml')
  mkdirSync(join(home, '.codex'))
  const server = '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n'
  writeFileSync(config, `model = "before"\n\n${server}`)
  const found = await discoverAgentMcpServers(
    { homeDir: home, env: {}, platform: 'darwin' },
    () => false
  )
  const github = found.find((row) => row.server.name === 'github')!
  const remove = () =>
    removeAgentMcpServerEntries(github.sources, agentMcpServerMergeKey('github', github.server))
  return { config, server, remove }
}

it('keeps a Codex config save that lands just before Move replaces the file', async () => {
  const { config, server, remove } = await codexGithub()
  // Codex saves its config after Orca's last check of the bytes, before the new file goes in.
  race.at = config
  race.save = () => writeFileSync(config, `model = "user-just-saved"\n\n${server}`)
  await remove()

  expect(race.at).toBeNull()
  expect(readFileSync(config, 'utf8')).toBe('model = "user-just-saved"\n')
})

it('leaves a config alone on a drive without hard links', async () => {
  const { config, server, remove } = await codexGithub()
  race.noLinks = true

  await expect(remove()).rejects.toThrow("can't edit")
  expect(readFileSync(config, 'utf8')).toBe(`model = "before"\n\n${server}`)
  expect(readdirSync(join(home, '.codex')).sort()).toEqual(['config.toml', 'config.toml.bak'])
})

it('puts back a config Orca held aside when it quit mid-publish', async () => {
  const config = join(home, 'mcp.json')
  writeFileSync(`${config}.orca-publishing`, '{ "mcpServers": { "mine": { "command": "m" } } }')

  expect(await readAgentConfigText(config)).toBe('{ "mcpServers": { "mine": { "command": "m" } } }')
  expect(readdirSync(home)).toEqual(['mcp.json'])
})

it.skipIf(process.platform === 'win32')(
  'edits the file a relative dotfile link names, read from its linked folder',
  async () => {
    // ~/.codex -> dotfiles/codex, and config.toml -> ../common/config.toml inside dotfiles.
    mkdirSync(join(home, 'dotfiles', 'codex'), { recursive: true })
    mkdirSync(join(home, 'dotfiles', 'common'))
    mkdirSync(join(home, 'common'))
    const real = join(home, 'dotfiles', 'common', 'config.toml')
    const decoy = join(home, 'common', 'config.toml')
    writeFileSync(real, 'a = 1\n')
    writeFileSync(decoy, 'a = 1\n')
    symlinkSync(join(home, 'dotfiles', 'codex'), join(home, '.codex'))
    symlinkSync('../common/config.toml', join(home, 'dotfiles', 'codex', 'config.toml'))

    const config = join(home, '.codex', 'config.toml')
    expect(await writeAgentConfigIfUnchanged(config, 'a = 2\n', 'a = 1\n')).toBe(true)
    expect([readFileSync(real, 'utf8'), readFileSync(decoy, 'utf8')]).toEqual([
      'a = 2\n',
      'a = 1\n'
    ])
    expect(lstatSync(join(home, 'dotfiles', 'codex', 'config.toml')).isSymbolicLink()).toBe(true)
  }
)
