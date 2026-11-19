import { describe, expect, it } from 'vitest'
import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'

describe('MCP server TOML ownership', () => {
  it('ignores apparent keys in strings, arrays and unrelated tables', () => {
    const config = [
      'description = """',
      '[mcp_servers.fake]',
      'mcp_servers = {}',
      '"""',
      'args = [',
      '"mcp_servers.quoted = {}",',
      ']',
      '[profile]',
      'mcp_servers = {}',
      '[mcp_servers.real]',
      'command = "agent"'
    ].join('\n')
    expect(readMcpServerTomlOwnership(config)).toEqual({
      names: new Set(['real']),
      ownsRoot: false
    })
  })
})
