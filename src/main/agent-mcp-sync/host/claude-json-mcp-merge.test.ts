import { describe, expect, it } from 'vitest'
import { mergeClaudeMcpServers } from './claude-json-mcp-merge'
import { fingerprintMcpValue } from './mcp-sync-ledger'

const linear = { type: 'http', url: 'https://mcp.linear.app/mcp' }
const fs = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }

describe('mergeClaudeMcpServers', () => {
  it('adds servers and keeps every other key of the host file', () => {
    const text = JSON.stringify({ numStartups: 3, projects: { '/w': { x: 1 } } })
    const merged = mergeClaudeMcpServers(text, { linear }, {})
    expect(JSON.parse(merged.text!)).toEqual({
      numStartups: 3,
      projects: { '/w': { x: 1 } },
      mcpServers: { linear }
    })
    expect(merged.outcomes).toEqual({ linear: 'added' })
    expect(merged.ledger).toEqual({ linear: fingerprintMcpValue(linear) })
  })

  it('is idempotent once synced', () => {
    const first = mergeClaudeMcpServers(null, { linear, fs }, {})
    const second = mergeClaudeMcpServers(first.text, { linear, fs }, first.ledger)
    expect(second.text).toBeNull()
    expect(second.outcomes).toEqual({ linear: 'unchanged', fs: 'unchanged' })
  })

  it('never touches a same-named server the host user configured', () => {
    const own = { command: 'my-linear' }
    const text = JSON.stringify({ mcpServers: { linear: own } })
    const merged = mergeClaudeMcpServers(text, { linear }, {})
    expect(merged.text).toBeNull()
    expect(merged.outcomes).toEqual({ linear: 'kept-host' })
    expect(merged.ledger).toEqual({})
  })

  it('treats a synced entry the host user edited as theirs', () => {
    const first = mergeClaudeMcpServers(null, { linear }, {})
    const edited = JSON.parse(first.text!)
    edited.mcpServers.linear.headers = { Authorization: 'Bearer host-token' }
    const merged = mergeClaudeMcpServers(
      JSON.stringify(edited),
      { linear: { ...linear, url: 'https://new.example/mcp' } },
      first.ledger
    )
    expect(merged.text).toBeNull()
    expect(merged.outcomes).toEqual({ linear: 'kept-host' })
  })

  it('updates its own entry and removes ones no longer sent', () => {
    const first = mergeClaudeMcpServers(
      JSON.stringify({ mcpServers: { hostOnly: { command: 'x' } } }),
      { linear, fs },
      {}
    )
    const next = { type: 'sse', url: 'https://mcp.linear.app/sse' }
    const merged = mergeClaudeMcpServers(first.text, { linear: next }, first.ledger)
    expect(JSON.parse(merged.text!).mcpServers).toEqual({
      hostOnly: { command: 'x' },
      linear: next
    })
    expect(merged.outcomes).toEqual({ linear: 'updated' })
    expect(Object.keys(merged.ledger)).toEqual(['linear'])
  })

  it('refuses a host file that is not a JSON object', () => {
    expect(() => mergeClaudeMcpServers('{not json', { linear }, {})).toThrow()
    expect(() => mergeClaudeMcpServers('[]', { linear }, {})).toThrow()
  })
})
