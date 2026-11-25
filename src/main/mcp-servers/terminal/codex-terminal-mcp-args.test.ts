import { describe, expect, it } from 'vitest'
import { mcpEnvWrapperCommand } from '../../../shared/mcp-servers/mcp-env-pairs'
import { codexTerminalMcpArgs } from './codex-terminal-mcp-args'

describe('a Codex terminal’s -c overrides for the host list', () => {
  it('names the relay token by its variable and writes Windows paths as TOML literal strings', () => {
    const { args, skipped } = codexTerminalMcpArgs(
      [
        {
          name: 'linear',
          url: 'http://127.0.0.1:4100/mcp-servers/cred-1/mcp',
          headers: { authorization: 'Bearer ${ORCA_MCP_TOKEN}' }
        },
        { name: 'pg', command: 'C:\\Tools\\pg mcp.exe', args: ['--db', 'C:\\data dir'] }
      ],
      'powershell'
    )
    expect(skipped).toEqual([])
    expect(args).toEqual([
      '-c',
      "mcp_servers.linear.url='http://127.0.0.1:4100/mcp-servers/cred-1/mcp'",
      '-c',
      "mcp_servers.linear.bearer_token_env_var='ORCA_MCP_TOKEN'",
      '-c',
      "mcp_servers.pg.command='C:\\Tools\\pg mcp.exe'",
      '-c',
      "mcp_servers.pg.args=['--db','C:\\data dir']"
    ])
  })

  it('leaves out a value only a double-quoted string can hold where Windows shells mangle it', () => {
    const server = { name: 'notes', command: 'node', args: ["it's.js"] }
    expect(codexTerminalMcpArgs([server], 'cmd')).toEqual({ args: [], skipped: ['notes'] })
    expect(codexTerminalMcpArgs([server], 'powershell')).toEqual({ args: [], skipped: ['notes'] })
    expect(codexTerminalMcpArgs([server], 'posix').args).toEqual([
      '-c',
      "mcp_servers.notes.command='node'",
      '-c',
      `mcp_servers.notes.args=["it's.js"]`
    ])
  })

  it('refuses a server that carries any header but the relay’s', () => {
    const server = {
      name: 'leaky',
      url: 'https://example.test/mcp',
      headers: { authorization: 'Bearer real-secret' }
    }
    expect(codexTerminalMcpArgs([server], 'posix')).toEqual({ args: [], skipped: ['leaky'] })
  })
})

describe('a WSL terminal’s guest wrapper in Codex overrides', () => {
  it('passes through the POSIX shell a WSL distro runs as literal strings', () => {
    const wrapper = mcpEnvWrapperCommand(
      {
        launcher: '/mnt/c/Users/A B/orca-ide',
        id: 'id-pg-000001',
        agent: 'codex',
        workspaceId: null
      },
      { command: 'npx', args: ['-y', 'pg-mcp'] }
    )
    const { args, skipped } = codexTerminalMcpArgs([{ name: 'pg', ...wrapper }], 'posix')
    expect(skipped).toEqual([])
    expect(args).toContain(
      `mcp_servers.pg.args=[${wrapper.args.map((arg) => `'${arg}'`).join(',')}]`
    )
  })
})

describe('a WSL server that runs the guest’s orca under Codex', () => {
  it('passes on the interop variables Codex would otherwise leave out', () => {
    const connect = {
      name: 'linear',
      command: '/mnt/c/Users/A/orca-ide',
      args: ['mcp', 'connect', 'id-linear-01', '--agent', 'codex']
    }
    const plain = { name: 'fs', command: 'npx', args: ['fs-mcp'] }
    const { args } = codexTerminalMcpArgs([connect, plain], 'posix', {
      names: new Set(['linear']),
      vars: ['WSL_INTEROP', 'WSL_DISTRO_NAME']
    })
    expect(args).toContain("mcp_servers.linear.env_vars=['WSL_INTEROP','WSL_DISTRO_NAME']")
    expect(args.some((arg) => arg.startsWith('mcp_servers.fs.env_vars'))).toBe(false)
  })
})
