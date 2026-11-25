import { describe, expect, it } from 'vitest'
import { codexArgsMcpServerNames } from './codex-structured-launch-args'

describe('codexArgsMcpServerNames', () => {
  it('names each server a -c/--config override sets as Codex does, keys raw, and stops at --', () => {
    expect(
      codexArgsMcpServerNames([
        '--config=mcp_servers={docs={url="https://docs.example/mcp"},db={command="pg"}}',
        '-cmcp_servers."my server".url="https://x.example/mcp"',
        '-c=mcp_servers.short.command="s"',
        '--config',
        'model="o3"',
        '--search',
        '--',
        '-c',
        'mcp_servers.after.command="x"'
      ])
    ).toEqual(['docs', 'db', '"my server"', 'short'])
  })

  it('forgets the names a later whole mcp_servers table replaces', () => {
    expect(
      codexArgsMcpServerNames(['-c', 'mcp_servers.docs.command="x"', '-c', 'mcp_servers={}'])
    ).toEqual([])
    expect(
      codexArgsMcpServerNames([
        '-c',
        'mcp_servers.docs.command="x"',
        '-c',
        'mcp_servers=none',
        '-c',
        'mcp_servers.db.command="y"'
      ])
    ).toEqual(['db'])
  })
})
