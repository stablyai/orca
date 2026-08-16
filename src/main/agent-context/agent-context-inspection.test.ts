import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectAgentContext } from './agent-context-inspection'
import { buildInstructionFileSources, MAX_ANCESTOR_LEVELS } from './agent-context-sources'
import { buildMcpFileSources } from './agent-config-file-sources'

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
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await writeFile(join(root, 'repo', 'AGENTS.md'), '# repo agents')
    await writeFile(join(root, 'AGENTS.md'), '# outside the repo')
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
    expect(repoAgents?.agents).not.toContain('cursor')
    // Why: the Codex-family walk ends at the git root; Claude's carries on.
    const outsidePaths = report.instructionFiles
      .filter((file) => file.scope === 'ancestor' && dirname(file.path) === root)
      .map((file) => file.label)
    expect(outsidePaths).toEqual(['CLAUDE.md', 'CLAUDE.local.md'])
  })

  it('treats a rules folder without rule files as checked but empty', async () => {
    const report = await inspectAgentContext({ target: { kind: 'native-host', homeDir, cwd } })
    expect(
      report.instructionFiles.find((file) => file.id === 'project-cursor-rules-dir')
    ).toMatchObject({ exists: false, entryCount: 0 })
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

  it('reads MCP servers out of an oversized ~/.claude.json instead of calling it invalid', async () => {
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { global: { command: 'g' } },
        projects: {
          [cwd]: {
            mcpServers: { local: { url: 'http://localhost:1' } },
            history: 'x'.repeat(300 * 1024)
          }
        },
        cachedChangelog: 'y'.repeat(200 * 1024)
      })
    )
    const report = await inspectAgentContext({ target: { kind: 'native-host', homeDir, cwd } })
    const claude = report.mcpFiles.find((file) => file.id === 'home-mcp:.claude.json')
    expect(claude?.inspection.status).toBe('valid')
    expect(claude?.inspection.servers.map((server) => server.name)).toEqual(['global', 'local'])
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
    // Why: the project-local scope shadows the user scope for the same name.
    expect(claude?.inspection.servers.find((server) => server.name === 'global')?.command).toBe(
      'dup'
    )
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

describe('inspectAgentContext access-path routing', () => {
  it('opens every row through toAccessPath while reporting the display path', async () => {
    const displayHome = '/wsl/home/u'
    const displayCwd = '/wsl/home/u/repo'
    const toAccessPath = (displayPath: string): string =>
      join(root, 'mount', ...displayPath.split('/').filter(Boolean))
    await mkdir(toAccessPath(`${displayCwd}/.claude`), { recursive: true })
    await mkdir(toAccessPath(`${displayHome}/.claude`), { recursive: true })
    await writeFile(toAccessPath(`${displayCwd}/CLAUDE.md`), '# app')
    await writeFile(
      toAccessPath(`${displayCwd}/.mcp.json`),
      JSON.stringify({ mcpServers: { linear: { command: 'npx' } } })
    )
    await writeFile(
      toAccessPath(`${displayHome}/.claude/settings.json`),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say' }] }] } })
    )

    const report = await inspectAgentContext({
      target: { kind: 'wsl', distro: 'Ubuntu', homeDir: displayHome, cwd: displayCwd },
      toAccessPath,
      pathApi: posix
    })
    expect(report.instructionFiles.find((file) => file.id === 'project-claude-md')).toMatchObject({
      path: `${displayCwd}/CLAUDE.md`,
      exists: true
    })
    expect(report.mcpFiles.find((file) => file.id === 'project-mcp:.mcp.json')).toMatchObject({
      path: `${displayCwd}/.mcp.json`,
      inspection: { exists: true, servers: [expect.objectContaining({ name: 'linear' })] }
    })
    expect(report.hookFiles.find((file) => file.id === 'home-claude-settings')).toMatchObject({
      path: `${displayHome}/.claude/settings.json`,
      hookCount: 1
    })
  })
})

describe('buildMcpFileSources', () => {
  it('names the agent that reads each MCP file and where its servers live', () => {
    const sources = buildMcpFileSources({ homeDir: '/h', cwd: '/h/repo', pathApi: posix })
    const byId = new Map(sources.map((source) => [source.id, source]))
    expect(byId.get('home-mcp:.claude.json')).toMatchObject({
      path: '/h/.claude.json',
      agents: ['claude'],
      extraServersPaths: [['projects', '/h/repo', 'mcpServers']]
    })
    expect(byId.get('home-mcp:.codex/config.toml')).toMatchObject({
      agents: ['codex'],
      format: 'codex-toml'
    })
    expect(byId.get('project-mcp:.vscode/mcp.json')).toMatchObject({
      path: '/h/repo/.vscode/mcp.json',
      agents: ['copilot'],
      candidate: expect.objectContaining({ serversPath: ['servers'] })
    })
    expect(byId.get('project-mcp:.gemini/settings.json')).toMatchObject({
      agents: ['gemini'],
      scope: 'project'
    })
    expect(byId.get('project-mcp:.cursor/mcp.json')).toMatchObject({ agents: ['cursor'] })
    expect(byId.get('project-mcp:opencode.json')).toMatchObject({
      agents: ['opencode'],
      candidate: expect.objectContaining({ serversPath: ['mcp'] })
    })
    expect(
      buildMcpFileSources({ homeDir: '/h', cwd: null, pathApi: posix }).every(
        (source) => source.scope === 'home'
      )
    ).toBe(true)
  })
})

describe('buildInstructionFileSources', () => {
  it('walks exactly MAX_ANCESTOR_LEVELS parents when the home directory is not reached', () => {
    const outside = join(root, 'elsewhere')
    const nested = join(
      outside,
      ...Array.from({ length: MAX_ANCESTOR_LEVELS + 3 }, (_, i) => `d${i}`)
    )
    const ancestors = buildInstructionFileSources({ homeDir, cwd: nested }).filter(
      (source) => source.scope === 'ancestor'
    )
    // Two Claude rows (CLAUDE.md + CLAUDE.local.md) per ancestor level; no git root, so no AGENTS.md.
    expect(ancestors).toHaveLength(MAX_ANCESTOR_LEVELS * 2)
    expect(ancestors[0]?.path).toBe(join(dirname(nested), 'CLAUDE.md'))
    expect(ancestors.every((source) => source.label !== 'AGENTS.md')).toBe(true)
  })

  it('stops the ancestor walk at the home directory, comparing paths as the host does', () => {
    const nested = join(homeDir, 'a', 'b')
    const ancestors = buildInstructionFileSources({ homeDir, cwd: nested }).filter(
      (source) => source.scope === 'ancestor'
    )
    expect(ancestors.map((source) => source.path)).toEqual([
      join(homeDir, 'a', 'CLAUDE.md'),
      join(homeDir, 'a', 'CLAUDE.local.md')
    ])
    const windows = buildInstructionFileSources({
      homeDir: 'C:\\Users\\Shane',
      cwd: 'c:\\users\\shane\\src\\app',
      pathApi: win32
    }).filter((source) => source.scope === 'ancestor')
    expect(windows.map((source) => source.path)).toEqual([
      'c:\\users\\shane\\src\\CLAUDE.md',
      'c:\\users\\shane\\src\\CLAUDE.local.md'
    ])
  })

  it('offers AGENTS.md to Codex-family agents from parents up to the git root only', () => {
    const gitRootDir = join(root, 'repo')
    const agentsRows = buildInstructionFileSources({ homeDir, cwd, gitRootDir }).filter(
      (source) => source.scope === 'ancestor' && source.label === 'AGENTS.md'
    )
    expect(agentsRows.map((source) => source.path)).toEqual([
      join(root, 'repo', 'packages', 'AGENTS.md'),
      join(root, 'repo', 'AGENTS.md')
    ])
    expect(agentsRows[0]?.agents).toEqual(['codex', 'opencode', 'amp', 'pi'])
    expect(
      buildInstructionFileSources({ homeDir, cwd, gitRootDir: cwd }).some(
        (source) => source.scope === 'ancestor' && source.label === 'AGENTS.md'
      )
    ).toBe(false)
  })

  it('omits project and ancestor rows without a workspace', () => {
    const sources = buildInstructionFileSources({ homeDir, cwd: null })
    expect(sources.every((source) => source.scope === 'home')).toBe(true)
  })
})
