import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectAgentContext } from './agent-context-inspection'
import { buildInstructionFileSources, MAX_ANCESTOR_LEVELS } from './agent-context-sources'

let root: string
let homeDir: string
let cwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-context-'))
  homeDir = join(root, 'home')
  cwd = join(root, 'repo', 'packages', 'app')
  await mkdir(join(homeDir, '.claude'), { recursive: true })
  await mkdir(join(cwd, '.cursor', 'rules'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('inspectAgentContext', () => {
  it('reports instruction files per agent, including ancestors, with existence', async () => {
    await writeFile(join(homeDir, '.claude', 'CLAUDE.md'), '# global')
    await writeFile(join(cwd, 'CLAUDE.md'), '# app')
    await writeFile(join(root, 'repo', 'AGENTS.md'), '# repo agents')
    await writeFile(join(cwd, '.cursor', 'rules', 'style.mdc'), 'rule')
    await writeFile(join(cwd, '.cursor', 'rules', 'notes.txt'), 'ignored')

    const report = await inspectAgentContext({
      target: { kind: 'native-host', homeDir, cwd }
    })
    const byId = new Map(report.instructionFiles.map((file) => [file.id, file]))

    expect(byId.get('home-claude-md')).toMatchObject({
      exists: true,
      scope: 'home',
      agents: ['claude']
    })
    expect(byId.get('project-claude-md')?.exists).toBe(true)
    expect(byId.get('project-claude-md')?.sizeBytes).toBe(5)
    expect(byId.get('project-gemini-md')?.exists).toBe(false)
    expect(byId.get('project-cursor-rules-dir')).toMatchObject({ exists: true, entryCount: 1 })
    const repoAgents = report.instructionFiles.find(
      (file) => file.scope === 'ancestor' && file.path === join(root, 'repo', 'AGENTS.md')
    )
    expect(repoAgents?.exists).toBe(true)
    expect(repoAgents?.agents).toContain('codex')
  })

  it('summarises Claude hooks and plugin decisions with the deciding settings file winning', async () => {
    await writeFile(
      join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'adhd@local': true, 'other@market': true },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }],
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'a' },
                { type: 'command', command: 'b' }
              ]
            }
          ]
        }
      })
    )
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'other@market': false } })
    )

    const report = await inspectAgentContext({
      target: { kind: 'native-host', homeDir, cwd }
    })

    const homeHooks = report.hookFiles.find((file) => file.id === 'home-claude-settings')
    expect(homeHooks).toMatchObject({ exists: true, events: ['PreToolUse', 'Stop'], hookCount: 3 })
    expect(report.hookFiles.find((file) => file.id === 'project-claude-settings')?.exists).toBe(
      false
    )
    expect(report.plugins).toEqual([
      expect.objectContaining({ name: 'adhd@local', enabled: true, scope: 'home' }),
      expect.objectContaining({ name: 'other@market', enabled: false, scope: 'project' })
    ])
  })

  it('inspects MCP files at home and project scope through the shared inspector', async () => {
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['linear-mcp'] } } })
    )
    await writeFile(join(cwd, '.mcp.json'), '{ not json')

    const report = await inspectAgentContext({
      target: { kind: 'native-host', homeDir, cwd }
    })
    const home = report.mcpFiles.find((file) => file.id === 'home-mcp:.claude.json')
    expect(home?.inspection.status).toBe('valid')
    expect(home?.inspection.servers.map((server) => server.name)).toEqual(['linear'])
    const project = report.mcpFiles.find((file) => file.id === 'project-mcp:.mcp.json')
    expect(project?.inspection.status).toBe('invalid')
    expect(
      report.mcpFiles.find((file) => file.id === 'project-mcp:.cursor/mcp.json')?.inspection.exists
    ).toBe(false)
  })

  it('merges Claude project-scoped servers from ~/.claude.json and reads Codex and OpenCode files', async () => {
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { global: { command: 'g' } },
        projects: {
          [cwd]: {
            mcpServers: { local: { url: 'http://localhost:1' }, global: { command: 'dup' } }
          },
          '/elsewhere': { mcpServers: { other: { command: 'x' } } }
        }
      })
    )
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(
      join(homeDir, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.codegraph]',
        'command = "codegraph"',
        'args = ["serve", "--mcp"]',
        '',
        '[mcp_servers."remote one"]',
        'url = "https://mcp.example" # trailing comment',
        'enabled = false',
        '',
        '[[skills.config]]',
        'path = "/x"'
      ].join('\n')
    )
    await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
    await writeFile(
      join(homeDir, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { oc: { type: 'local', command: ['bun', 'x'] } } })
    )

    const report = await inspectAgentContext({ target: { kind: 'native-host', homeDir, cwd } })
    const claude = report.mcpFiles.find((file) => file.id === 'home-mcp:.claude.json')
    expect(claude?.inspection.servers.map((server) => server.name)).toEqual(['global', 'local'])
    const codex = report.mcpFiles.find((file) => file.id === 'home-mcp:.codex/config.toml')
    expect(codex?.inspection.status).toBe('valid')
    expect(codex?.inspection.servers).toEqual([
      expect.objectContaining({
        name: 'codegraph',
        transport: 'stdio',
        command: 'codegraph',
        status: 'enabled'
      }),
      expect.objectContaining({
        name: 'remote one',
        transport: 'http',
        url: 'https://mcp.example',
        status: 'disabled'
      })
    ])
    const opencode = report.mcpFiles.find((file) => file.id === 'home-mcp:opencode.json')
    expect(opencode?.inspection.servers).toEqual([
      expect.objectContaining({ name: 'oc', transport: 'stdio', command: 'bun' })
    ])
    expect(
      report.mcpFiles.find((file) => file.id === 'project-mcp:.codex/config.toml')?.inspection
        .exists
    ).toBe(false)
  })

  it('reports an invalid settings file instead of dropping it', async () => {
    await writeFile(join(homeDir, '.claude', 'settings.json'), '{')
    const report = await inspectAgentContext({ target: { kind: 'native-host', homeDir, cwd } })
    const home = report.hookFiles.find((file) => file.id === 'home-claude-settings')
    expect(home?.exists).toBe(true)
    expect(home?.error).toBeTruthy()
  })
})

describe('buildInstructionFileSources', () => {
  it('stops the ancestor walk at the home directory and at the level cap', () => {
    const nested = join(
      homeDir,
      ...Array.from({ length: MAX_ANCESTOR_LEVELS + 3 }, (_, i) => `d${i}`)
    )
    const sources = buildInstructionFileSources({ homeDir, cwd: nested })
    const ancestors = sources.filter((source) => source.scope === 'ancestor')
    expect(ancestors.length).toBeLessThanOrEqual(MAX_ANCESTOR_LEVELS * 2)
    expect(ancestors.every((source) => !source.path.startsWith(join(homeDir, 'CLAUDE')))).toBe(true)
  })

  it('omits project and ancestor rows without a workspace', () => {
    const sources = buildInstructionFileSources({ homeDir, cwd: null })
    expect(sources.every((source) => source.scope === 'home')).toBe(true)
  })
})
