import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { CODEX_MCP_BLOCK_START, mergeCodexMcpServers } from './codex-toml-mcp-merge'

const linear = { url: 'https://mcp.linear.app/mcp' }
const fs = { command: 'npx', args: ['-y', 'server-fs'], env: { TOKEN: 'secret' } }

describe('mergeCodexMcpServers', () => {
  it('appends a marked block after the host config and is idempotent', () => {
    const host = 'model = "gpt-5"\n\n[mcp_servers.hostOnly]\ncommand = "x"\n'
    const first = mergeCodexMcpServers(host, { linear, fs }, null)
    expect(first.outcomes).toEqual({ linear: 'added', fs: 'added' })
    expect(first.text!.startsWith(host)).toBe(true)
    expect(parse(first.text!)).toEqual({
      model: 'gpt-5',
      mcp_servers: { hostOnly: { command: 'x' }, linear, fs }
    })
    const second = mergeCodexMcpServers(first.text, { linear, fs }, first.blockPrint)
    expect(second.text).toBeNull()
    expect(second.outcomes).toEqual({ linear: 'unchanged', fs: 'unchanged' })
  })

  it('lets servers defined outside the block win', () => {
    const host = '[mcp_servers.linear]\nurl = "https://host.example/mcp"\n'
    const merged = mergeCodexMcpServers(host, { linear, fs }, null)
    expect(merged.outcomes).toEqual({ linear: 'kept-host', fs: 'added' })
    expect(parse(merged.text!)).toEqual({
      mcp_servers: { linear: { url: 'https://host.example/mcp' }, fs }
    })
  })

  it('rewrites only its block and removes it when nothing is sent', () => {
    const first = mergeCodexMcpServers('a = 1\n', { linear, fs }, null)
    const withTail = `${first.text}\n[profiles.x]\nmodel = "o3"\n`
    const fsV2 = { ...fs, args: ['-y', 'v2'] }
    const updated = mergeCodexMcpServers(withTail, { fs: fsV2 }, first.blockPrint)
    expect(updated.outcomes).toEqual({ fs: 'updated' })
    expect(parse(updated.text!)).toEqual({
      a: 1,
      mcp_servers: { fs: fsV2 },
      profiles: { x: { model: 'o3' } }
    })
    const cleared = mergeCodexMcpServers(updated.text, {}, updated.blockPrint)
    expect(cleared.text).toBe('a = 1\n\n[profiles.x]\nmodel = "o3"\n')
    expect(cleared.blockPrint).toBeNull()
  })

  it('keeps a hand-edited block as the host user’s own config', () => {
    const first = mergeCodexMcpServers('', { linear }, null)
    const edited = first.text!.replace('https://mcp.linear.app/mcp', 'https://edited.example/mcp')
    const merged = mergeCodexMcpServers(edited, { linear, fs }, first.blockPrint)
    expect(merged.outcomes).toEqual({ linear: 'kept-host', fs: 'added' })
    expect(parse(merged.text!)).toEqual({
      mcp_servers: { linear: { url: 'https://edited.example/mcp' }, fs }
    })
    expect(merged.text!.split(CODEX_MCP_BLOCK_START)).toHaveLength(2)
  })

  it('does not extend an inline mcp_servers table', () => {
    const merged = mergeCodexMcpServers('mcp_servers = { a = { command = "x" } }\n', { fs }, null)
    expect(merged.text).toBeNull()
    expect(merged.outcomes).toEqual({ fs: 'kept-host' })
  })

  it('refuses invalid TOML and an unterminated block', () => {
    expect(() => mergeCodexMcpServers('[[broken', { fs }, null)).toThrow()
    expect(() => mergeCodexMcpServers(`${CODEX_MCP_BLOCK_START}\n`, { fs }, null)).toThrow()
  })

  it('keeps owning its block when Codex only reformats it (same servers, different text)', () => {
    const first = mergeCodexMcpServers(
      null,
      { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
      null
    )
    const reformatted = first.text!.replace(
      /args = \[ "-y", "server-fs" \]|args = \["-y", "server-fs"\]/,
      "args = [ '-y', 'server-fs' ]"
    )
    expect(reformatted).not.toBe(first.text)
    const again = mergeCodexMcpServers(
      reformatted,
      { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
      first.blockPrint
    )
    expect(again.outcomes).toEqual({ fs: 'unchanged' })
    // Still one marked block, not an unmarked copy plus a new block.
    const text = again.text ?? reformatted
    expect(text.split(CODEX_MCP_BLOCK_START)).toHaveLength(2)
    expect(Object.keys(parse(text).mcp_servers as object)).toEqual(['fs'])
  })
})
