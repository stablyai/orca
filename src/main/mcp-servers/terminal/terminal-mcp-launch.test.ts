import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { changeBotToolEntries } from '../../bots/bot-tools-file'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { ClaudeAgentTeamsService } from '../../runtime/terminal/agent-teams/claude-agent-teams-service'
import type { AgentTeamsTerminalApi } from '../../runtime/terminal/agent-teams/claude-agent-teams-types'
import { withTerminalMcpServers, type TerminalMcpLaunchInput } from './terminal-mcp-launch'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const TOKEN = 'relay-token-4f1c'
const SECRET = 'postgres://app:hunter2@db/prod'
const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: TOKEN }) }
let launcher = ''

beforeEach(() => {
  const userData = tempDir('mcp-terminal-user-data-')
  launcher = join(tempDir('mcp-terminal-cli-'), 'orca')
  writeFileSync(launcher, '#!/bin/sh\n')
  setAppEnvironment({
    getPath: () => userData,
    getAppPath: () => userData,
    getVersion: () => '0.0.0',
    isPackaged: () => true,
    getCliLauncherPath: () => launcher,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => {
  delete process.env.ORCA_MCP_SERVERS
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A signed-in URL server (relayed), a command server with a saved secret, and a plain URL server. */
async function hostList(): Promise<string> {
  const folder = tempDir('mcp-host-list-')
  await changeBotToolEntries(folder, () => [
    {
      server: { name: 'keyed', url: 'https://keyed.example.test/mcp', credential: 'cred-keyed-1' },
      extras: { id: 'id-keyed-0001' }
    },
    {
      server: { name: 'pg', command: 'npx', args: ['pg-mcp'], env: { DATABASE_URL: SECRET } },
      extras: { id: 'id-pg-000001' }
    },
    {
      server: { name: 'plain', url: 'https://plain.example.test/mcp' },
      extras: { id: 'id-plain-001' }
    }
  ])
  return folder
}

/** The env a team's teammates start with, for a lead whose terminal had `leadEnv`. */
const teammateEnv = (leadEnv: Record<string, string>): Record<string, string> =>
  new ClaudeAgentTeamsService().createLaunchEnv({
    leaderHandle: 'term_lead',
    baseEnv: leadEnv,
    shimDir: '/shim',
    shimBin: null
  }).env

/** The env a teammate's split pane gets from `team`, as the lead's tmux shim asks for one. */
async function teammateSplitEnv(
  service: ClaudeAgentTeamsService,
  team: { teamId: string; token: string; leaderPane: string }
): Promise<Record<string, string>> {
  let env: Record<string, string> = {}
  const unused = (): never => {
    throw new Error('a split asks for nothing else')
  }
  const api: AgentTeamsTerminalApi = {
    allocateTerminalHandle: () => 'term_teammate',
    splitTerminal: async (_handle, opts) => {
      env = opts.env ?? {}
      return { handle: 'term_teammate', tabId: 'tab', paneRuntimeId: -1, leafId: 'leaf' }
    },
    readTerminal: unused,
    sendTerminal: unused,
    focusTerminal: unused,
    closeTerminal: unused,
    showTerminal: unused
  }
  const reply = await service.handleTmuxCompat(
    { ...team, envPane: team.leaderPane, argv: ['split-window', 'claude'] },
    api
  )
  expect(reply.stderr).toBe('')
  return env
}

const launch = (agent: TuiAgent, command: string): TerminalMcpLaunchInput => ({
  launchAgent: agent,
  command,
  env: { PATH: '/usr/bin:/bin', OPENCODE_CONFIG_CONTENT: '{"keep":true}' },
  envToDelete: ['SOME_KEY'],
  shell: 'posix',
  cwd: undefined,
  worktreeId: 'repo-1::/r',
  connectionId: undefined,
  isFreshLaunch: true,
  codexHome: null
})

describe('the host list in an agent terminal', () => {
  it('leaves the launch exactly as it was while the switch is off', async () => {
    const hostFolder = await hostList()
    for (const [agent, command] of [
      ['claude', 'claude --foo'],
      ['codex', 'codex --foo'],
      ['claude-agent-teams', 'orca claude-teams --foo']
    ] as const) {
      const input = launch(agent, command)
      const before = structuredClone({ env: input.env, envToDelete: input.envToDelete })
      const result = await withTerminalMcpServers(input, { relay, hostFolder })
      expect(result).toEqual({ command, pane: null })
      expect({ env: input.env, envToDelete: input.envToDelete }).toEqual(before)
    }
    expect(teammateEnv({ ORCA_MCP_TOKEN: TOKEN })).not.toHaveProperty('ORCA_MCP_TOKEN')
  })

  it('gives an Agent Teams lead the config after its claude-teams subcommand, which forwards it to claude', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const hostFolder = await hostList()
    const input = launch('claude-agent-teams', 'orca claude-teams --foo')
    const { command, pane } = await withTerminalMcpServers(input, { relay, hostFolder })

    const parsed = tokenizeStartupCommand(command!, 'posix')
    const tokens = parsed.ok ? parsed.tokens : []
    expect(tokens.slice(0, 2)).toEqual(['orca', 'claude-teams'])
    expect(tokens[2]).toMatch(/^--mcp-config=/)
    expect(tokens.slice(3)).toEqual(['--foo'])
    expect(command).not.toContain(TOKEN)
    expect(pane?.agent).toBe('claude')
    // Teammates start with the team's env, so the relay env they need is taken from the lead's.
    expect(teammateEnv(input.env)).toMatchObject({
      ORCA_MCP_TOKEN: TOKEN,
      NO_PROXY: expect.stringContaining('127.0.0.1'),
      no_proxy: expect.stringContaining('127.0.0.1')
    })
  })

  it('gives a team made before its lead’s spawn the lead’s relay env, only with the switch on and the team’s token', async () => {
    const hostFolder = await hostList()
    for (const enabled of [false, true]) {
      process.env.ORCA_MCP_SERVERS = enabled ? '1' : '0'
      const service = new ClaudeAgentTeamsService()
      const team = service.createLaunchEnv({
        leaderHandle: 'term_lead',
        baseEnv: { PATH: '/usr/bin:/bin' },
        shimDir: '/shim',
        shimBin: null
      })
      const input = launch('claude', 'claude --teammate-mode auto')
      Object.assign(input.env, team.env)
      await withTerminalMcpServers(input, { relay, hostFolder })
      service.shareLeadMcpRelayEnv(input.env)
      const env = await teammateSplitEnv(service, team)
      if (enabled) {
        expect(env).toMatchObject({ ORCA_MCP_TOKEN: TOKEN, NO_PROXY: expect.any(String) })
      } else {
        expect(input.env).not.toHaveProperty('ORCA_MCP_TOKEN')
        expect(env).not.toHaveProperty('ORCA_MCP_TOKEN')
        expect(env).not.toHaveProperty('NO_PROXY')
      }
    }
    // Another team's env, or one that only names this team, adds nothing to it.
    const service = new ClaudeAgentTeamsService()
    const team = service.createLaunchEnv({
      leaderHandle: 'term_lead',
      baseEnv: {},
      shimDir: '/shim',
      shimBin: null
    })
    service.shareLeadMcpRelayEnv({
      ORCA_AGENT_TEAMS_TEAM_ID: team.teamId,
      ORCA_AGENT_TEAMS_TOKEN: 'not-the-team-token',
      ORCA_MCP_TOKEN: TOKEN
    })
    expect(await teammateSplitEnv(service, team)).not.toHaveProperty('ORCA_MCP_TOKEN')
  })

  it('never puts a saved value or the relay token on the command line or in the launch file', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const hostFolder = await hostList()
    const input = launch('claude', 'claude --foo')
    const { command } = await withTerminalMcpServers(input, { relay, hostFolder })

    const file = /--mcp-config=([^' ]+)/.exec(command ?? '')?.[1]
    expect(file).toBeDefined()
    expect(command).not.toContain(TOKEN)
    expect(command).not.toContain('hunter2')
    if (process.platform !== 'win32') {
      expect(statSync(file!).mode & 0o777).toBe(0o600)
    }
    const config = readFileSync(file!, 'utf8')
    expect(config).not.toContain(TOKEN)
    expect(config).not.toContain('hunter2')
    expect(JSON.parse(config).mcpServers).toEqual({
      keyed: {
        type: 'http',
        url: 'http://127.0.0.1:4100/mcp-servers/cred-keyed-1/mcp',
        headers: { authorization: 'Bearer ${ORCA_MCP_TOKEN}' }
      },
      pg: {
        type: 'stdio',
        command: launcher,
        args: ['mcp', 'exec', 'id-pg-000001', '--agent', 'claude', '--workspace', 'repo-1::/r'],
        env: { ORCA_USER_DATA_PATH: expect.any(String) }
      },
      plain: { type: 'http', url: 'https://plain.example.test/mcp' }
    })
    // The token rides only in the CLI's env, which neither history nor its config files keep.
    expect(input.env.ORCA_MCP_TOKEN).toBe(TOKEN)
    expect(JSON.stringify(input.env)).not.toContain('hunter2')
  })

  it('gives a Codex terminal the secret-env server through orca mcp exec, never its value', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const folder = tempDir('mcp-host-list-')
    await changeBotToolEntries(folder, () => [
      {
        server: { name: 'pg', command: 'npx', args: ['pg-mcp'], env: { DATABASE_URL: SECRET } },
        extras: { id: 'id-pg-000001' }
      }
    ])
    const input = launch('codex', 'codex')
    const { command } = await withTerminalMcpServers(input, { relay, hostFolder: folder })
    const parsed = tokenizeStartupCommand(command!, 'posix')
    const tokens = parsed.ok ? parsed.tokens : []
    expect(tokens).toContain(`mcp_servers.pg.command='${launcher}'`)
    expect(tokens).toContain(
      "mcp_servers.pg.args=['mcp','exec','id-pg-000001','--agent','codex','--workspace','repo-1::/r']"
    )
    expect(command).not.toContain('hunter2')
    expect(JSON.stringify(input.env)).not.toContain('hunter2')
  })

  it('reaches a shared command server through the relay instead of starting its own copy', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const folder = tempDir('mcp-host-list-')
    await changeBotToolEntries(folder, () => [
      {
        server: { name: 'pg', command: 'npx', args: ['pg-mcp'], env: { DATABASE_URL: SECRET } },
        extras: { id: 'id-pg-000001', sharedProcess: true }
      }
    ])
    const input = launch('claude', 'claude')
    const { command } = await withTerminalMcpServers(input, { relay, hostFolder: folder })
    const file = /--mcp-config=([^' ]+)/.exec(command ?? '')?.[1]
    const config = readFileSync(file!, 'utf8')
    expect(JSON.parse(config).mcpServers).toEqual({
      pg: {
        type: 'http',
        url: 'http://127.0.0.1:4100/mcp-processes/id-pg-000001/mcp',
        headers: { authorization: 'Bearer ${ORCA_MCP_TOKEN}' }
      }
    })
    expect(config).not.toContain('hunter2')
  })
})
