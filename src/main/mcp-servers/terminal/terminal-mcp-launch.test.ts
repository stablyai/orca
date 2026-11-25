import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { changeBotToolEntries } from '../../bots/bot-tools-file'
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

const launch = (agent: 'claude' | 'codex', command: string): TerminalMcpLaunchInput => ({
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
    for (const agent of ['claude', 'codex'] as const) {
      const input = launch(agent, `${agent} --foo`)
      const before = structuredClone({ env: input.env, envToDelete: input.envToDelete })
      const result = await withTerminalMcpServers(input, { relay, hostFolder })
      expect(result).toEqual({ command: `${agent} --foo`, pane: null })
      expect({ env: input.env, envToDelete: input.envToDelete }).toEqual(before)
    }
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
