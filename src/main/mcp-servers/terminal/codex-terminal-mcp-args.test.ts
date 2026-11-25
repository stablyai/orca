import { describe, expect, it } from 'vitest'
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
