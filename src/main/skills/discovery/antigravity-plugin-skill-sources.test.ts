import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverSkills } from './skill-native-discovery'

const route = vi.hoisted(() => ({ runsInOrcaHome: false }))
vi.mock('../../antigravity/antigravity-chat-route', () => ({
  lastAntigravityChatRunsInOrcaHome: () => route.runsInOrcaHome
}))

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-antigravity-plugins-'))
})

afterEach(async () => {
  route.runsInOrcaHome = false
  await rm(directory, { recursive: true, force: true })
})

async function writePlugin(
  folder: string,
  manifestPath: string[] | null,
  manifest: Record<string, unknown> | unknown[] | string = {}
): Promise<void> {
  const plugin = join(directory, 'home', '.gemini', 'config', 'plugins', folder)
  await mkdir(join(plugin, 'skills', `${folder}-folder`), { recursive: true })
  await writeFile(
    join(plugin, 'skills', `${folder}-folder`, 'SKILL.md'),
    `---\nname: ${folder}-skill\ndescription: From ${folder}\n---\n`
  )
  if (manifestPath) {
    await mkdir(join(plugin, ...manifestPath.slice(0, -1)), { recursive: true })
    await writeFile(
      join(plugin, ...manifestPath),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    )
  }
}

async function discoverWorkspaceSkills() {
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  return discoverSkills({
    homeDir: join(directory, 'home'),
    cwd: workspace,
    repos: [],
    refresh: true
  })
}

describe('Antigravity plugin skill discovery', () => {
  it('lists skills of the plugins agy enables, by their unprefixed names', async () => {
    await writePlugin('on', ['plugin.json'], { name: 'on' })
    await writePlugin('alt-manifest', ['.antigravity-plugin', 'plugin.json'])
    await writePlugin('ships-off', ['plugin.json'], { disabled: true })
    await writePlugin('turned-on', ['plugin.json'], { disabled: true })
    await writePlugin('turned-off', ['plugin.json'])
    await writePlugin('gemini-manifest', ['.gemini-plugin', 'plugin.json'])
    await writePlugin('no-manifest', null)
    await writePlugin('invalid-json', ['plugin.json'], '{')
    await writePlugin('empty-manifest', ['plugin.json'], '')
    await writePlugin('array-manifest', ['plugin.json'], [])
    await writePlugin('string-disabled', ['plugin.json'], { disabled: 'true' })
    await writePlugin('jsonc', ['plugin.json'], '{\n  // comment\n  "name": "jsonc",\n}')
    await writePlugin('bom', ['plugin.json'], '\uFEFF{"name": "bom"}')
    await writeFile(
      join(directory, 'home', '.gemini', 'config', 'config.json'),
      JSON.stringify({
        plugins: { 'turned-on': { enabled: true }, 'turned-off': { enabled: false } }
      })
    )

    const result = await discoverWorkspaceSkills()

    const pluginSkills = result.skills.filter((skill) => skill.sourceKind === 'plugin')
    expect(pluginSkills.map((skill) => skill.name).sort()).toEqual([
      'alt-manifest-skill',
      'bom-skill',
      'gemini-manifest-skill',
      'jsonc-skill',
      'on-skill',
      'turned-on-skill'
    ])
    expect(pluginSkills.every((skill) => skill.pluginName === undefined)).toBe(true)
    const pluginSources = result.sources.filter(
      (source) => source.sourceKind === 'plugin' && source.exists
    )
    expect(pluginSources.map((source) => source.owner)).toEqual(Array(6).fill('antigravity'))
  })

  it('reads only the first manifest agy finds, in its precedence order', async () => {
    await writePlugin('antigravity-first', ['.antigravity-plugin', 'plugin.json'])
    await writePlugin('antigravity-first', ['.gemini-plugin', 'plugin.json'], { disabled: true })
    await writePlugin('antigravity-first', ['plugin.json'], { disabled: true })
    await writePlugin('gemini-over-root', ['.gemini-plugin', 'plugin.json'], { disabled: true })
    await writePlugin('gemini-over-root', ['plugin.json'])
    await writePlugin('invalid-first', ['.antigravity-plugin', 'plugin.json'], '{')
    await writePlugin('invalid-first', ['plugin.json'])
    await writePlugin('string-disabled-first', ['.gemini-plugin', 'plugin.json'], {
      disabled: 'false'
    })
    await writePlugin('string-disabled-first', ['plugin.json'])

    const result = await discoverWorkspaceSkills()

    expect(
      result.skills.filter((skill) => skill.sourceKind === 'plugin').map((skill) => skill.name)
    ).toEqual(['antigravity-first-skill'])
  })

  it('skips manifests and config.json files over their size caps', async () => {
    await writePlugin('small', ['plugin.json'])
    await writePlugin('large', ['plugin.json'], { padding: 'x'.repeat(4 * 1024) })
    await writeFile(
      join(directory, 'home', '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { small: { enabled: false } }, padding: 'x'.repeat(64 * 1024) })
    )

    const result = await discoverWorkspaceSkills()

    expect(
      result.skills.filter((skill) => skill.sourceKind === 'plugin').map((skill) => skill.name)
    ).toEqual(['small-skill'])
  })

  it('skips a plugin whose manifest nests too deeply to parse', async () => {
    await writePlugin('valid', ['plugin.json'])
    await writePlugin('deep', ['plugin.json'], '['.repeat(10000))

    const result = await discoverWorkspaceSkills()

    expect(
      result.skills.filter((skill) => skill.sourceKind === 'plugin').map((skill) => skill.name)
    ).toEqual(['valid-skill'])
  })

  // Orca's server and agy on Orca's home get skill folders linked in, not `~/.gemini`'s plugins.
  it('lists none while chats run in a home Orca owns', async () => {
    await writePlugin('on', ['plugin.json'])
    route.runsInOrcaHome = true

    const result = await discoverWorkspaceSkills()

    expect(result.skills.filter((skill) => skill.sourceKind === 'plugin')).toEqual([])
  })
})
