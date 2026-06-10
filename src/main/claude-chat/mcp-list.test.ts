import { describe, it, expect } from 'vitest'
import { listMcpServers } from './mcp-list'

describe('listMcpServers', () => {
  it('parses server names from claude mcp list output', async () => {
    const fakeRun = async (_cmd: string, _args: string[], _opts: { cwd: string }) => ({
      stdout:
        'filesystem: npx @modelcontextprotocol/server-filesystem /path\ngithub: npx @github/mcp-server\n'
    })
    const names = await listMcpServers('/cwd', fakeRun)
    expect(names).toEqual(['filesystem', 'github'])
  })

  it('returns empty array when no servers configured', async () => {
    const fakeRun = async () => ({ stdout: 'No MCP servers configured\n' })
    const names = await listMcpServers('/cwd', fakeRun)
    expect(names).toEqual([])
  })

  it('returns empty array when run throws', async () => {
    const fakeRun = async (): Promise<{ stdout: string }> => {
      throw new Error('command not found')
    }
    const names = await listMcpServers('/cwd', fakeRun)
    expect(names).toEqual([])
  })
})
