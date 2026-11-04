import { describe, expect, it } from 'vitest'
import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'
import { getTomlTableHeader } from './config-toml-line-scan'

describe('MCP server TOML ownership', () => {
  it.each([
    '[mcp_servers."server.with.dot"]\ncommand = "agent"',
    '[mcp_servers]\n"server.with.dot" = { command = "agent" }',
    'mcp_servers."server.with.dot".command = "agent"',
    '[mcp_servers."server.with.dot".env]\nMODE = "fixture"',
    '[mcp_servers."server.with.dot"] # see [docs]\ncommand = "agent"',
    '[mcp_servers."server.with.dot"] # server\r\ncommand = "agent"\r\n',
    '[[mcp_servers."server.with.dot"]] # array\r\ncommand = "agent"'
  ])('recognizes the decoded server name in %s', (config) => {
    expect(readMcpServerTomlOwnership(config)).toEqual({
      names: new Set(['server.with.dot']),
      ownsRoot: false
    })
  })

  it('treats a root assignment as ownership of the whole closed table', () => {
    expect(readMcpServerTomlOwnership('"mcp_servers" = { shared = { enabled = false } }')).toEqual({
      names: new Set(),
      ownsRoot: true
    })
  })

  it.each([
    '[profile] # comment\r\nmcp_servers = { foo = {} }\r\n',
    '[profile] # see [docs]\nmcp_servers = { foo = {} }\n',
    '[not valid]\nmcp_servers = { foo = {} }\n'
  ])('does not treat a nested assignment as a canonical root in %s', (config) => {
    expect(readMcpServerTomlOwnership(config)).toEqual({ names: new Set(), ownsRoot: false })
  })

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

describe('commented TOML headers', () => {
  it.each<[string, string | null]>([
    ['[mcp_servers."name#with]bracket"] # see [docs]\r', '[mcp_servers."name#with]bracket"]'],
    ['[[mcp_servers.name]] # comment\r', '[[mcp_servers.name]]'],
    ["[mcp_servers.'literal#name'] # comment", "[mcp_servers.'literal#name']"],
    ['# [mcp_servers.fake]', null],
    ['command = "[mcp_servers.fake]"', null]
  ])('recognizes the structural header in %s', (line, header) => {
    expect(getTomlTableHeader(line)).toBe(header)
  })
})
