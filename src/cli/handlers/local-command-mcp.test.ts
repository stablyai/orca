import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { serveLocalCommandMcp, type LocalCommandMcpDeps } from './local-command-mcp'

async function exchange(
  messages: object[],
  run: LocalCommandMcpDeps['run'] = vi.fn(async () => ({
    requestId: 'lc_x',
    status: 'finished' as const,
    result: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 4,
      stdout: 'iPhone 16 (Booted)\n',
      stderr: '',
      truncated: false
    }
  }))
): Promise<{ replies: Record<string, unknown>[]; run: typeof run }> {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
  const done = serveLocalCommandMcp({ input, output, run })
  for (const message of messages) {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  await vi.waitFor(() => {
    const ids = chunks.join('').split('\n').filter(Boolean).length
    expect(ids).toBe(messages.filter((m) => 'id' in m).length)
  })
  input.end()
  await done
  return {
    replies: chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    run
  }
}

describe('local-command MCP server', () => {
  it('lists run_local_command and returns the command output as tool text', async () => {
    const { replies, run } = await exchange([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'run_local_command',
          arguments: { command: 'xcrun simctl list devices booted', timeout_sec: 30 }
        }
      }
    ])
    expect(replies[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18' } })
    expect(replies[1]).toMatchObject({ id: 2, result: { tools: [{ name: 'run_local_command' }] } })
    expect(replies[2]).toMatchObject({
      id: 3,
      result: {
        isError: false,
        content: [{ type: 'text', text: expect.stringContaining('iPhone 16 (Booted)') }]
      }
    })
    expect(run).toHaveBeenCalledWith({
      command: 'xcrun simctl list devices booted',
      timeoutSec: 30
    })
  })

  it('tells the agent not to retry a denied command', async () => {
    const { replies } = await exchange(
      [
        {
          id: 1,
          method: 'tools/call',
          params: { name: 'run_local_command', arguments: { command: 'ls' } }
        }
      ],
      vi.fn(async () => ({
        requestId: 'lc_x',
        status: 'declined' as const,
        declineReason: 'denied' as const
      }))
    )
    expect(replies[0]).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('denied') }] }
    })
  })
})
