import { describe, expect, it } from 'vitest'
import { removeTomlMcpServers } from './toml-mcp-server-removal'

const remove = (text: string, ...names: string[]) =>
  removeTomlMcpServers(text, 'mcp_servers', new Set(names))

describe('removeTomlMcpServers', () => {
  it('removes every spelling of the server and keeps all other bytes', () => {
    const config = [
      '# my codex config',
      'model = "o3"',
      'mcp_servers.github.enabled = true',
      '',
      '[mcp_servers.github]',
      '# the GitHub server',
      'command = "npx"',
      'args = [',
      '  "-y",',
      '  "[not.a.header]",',
      ']',
      '',
      '[mcp_servers.github.env]',
      'GITHUB_TOKEN = "t"',
      '',
      '# kept: describes the next table',
      '[mcp_servers.linear]',
      'url = "https://mcp.linear.app/mcp"',
      '',
      '[mcp_servers]',
      'github.startup_timeout_sec = 9',
      'figma = { url = "https://figma.com/mcp" }',
      'context7 = { url = "https://mcp.context7.com/mcp" }',
      ''
    ].join('\n')
    expect(remove(config, 'github', 'figma')).toBe(
      [
        '# my codex config',
        'model = "o3"',
        '',
        '# kept: describes the next table',
        '[mcp_servers.linear]',
        'url = "https://mcp.linear.app/mcp"',
        '',
        '[mcp_servers]',
        'context7 = { url = "https://mcp.context7.com/mcp" }',
        ''
      ].join('\n')
    )
  })

  it('keeps CRLF and drops the gap a trailing table leaves', () => {
    expect(
      remove('a = 1\r\n\r\n[mcp_servers.x]\r\ncommand = "x"\r\n\r\n[b]\r\nc = 2\r\n', 'x')
    ).toBe('a = 1\r\n\r\n[b]\r\nc = 2\r\n')
    expect(remove('a = 1\n\n[mcp_servers."my.server"]\nurl = "https://x.dev"\n', 'my.server')).toBe(
      'a = 1\n'
    )
  })

  it('refuses a server inside an inline root table', () => {
    expect(remove('mcp_servers = { x = { command = "x" } }\n', 'x')).toBeNull()
  })
})
