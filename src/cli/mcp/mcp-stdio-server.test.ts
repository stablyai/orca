import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { serveMcpOverStdio, type McpToolRun, type McpToolRunner } from './mcp-stdio-server'

type Reply = { id?: unknown; result?: unknown; error?: unknown }

function startServer(runTool: McpToolRunner) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: Reply[] = []
  let buffered = ''
  output.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      lines.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  const done = serveMcpOverStdio({ input, output, runTool, version: '9.9.9' })
  const request = (message: Record<string, unknown>): void => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const close = async (): Promise<Reply[]> => {
    input.end()
    await done
    return lines
  }
  return { request, close }
}

const replyWith =
  (run: McpToolRun): McpToolRunner =>
  async () =>
    run

describe('serveMcpOverStdio', () => {
  it('maps tool arguments to the matching orca CLI invocation', async () => {
    const calls: string[][] = []
    const server = startServer(async (_tool, argv) => {
      calls.push(argv)
      return { exitCode: 0, stdout: '{"ok":true,"result":{"sent":true}}\n', stderr: '' }
    })
    server.request({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'terminal_send',
        arguments: { terminal: 'term_1', text: '--help me\nnow', enter: true, interrupt: false }
      }
    })
    server.request({
      id: 2,
      method: 'tools/call',
      params: { name: 'terminal_wait', arguments: { terminal: 'term_1', for: 'tui-idle' } }
    })
    const replies = await server.close()

    expect(calls).toEqual([
      ['terminal', 'send', '--terminal=term_1', '--text=--help me\nnow', '--enter', '--json'],
      ['terminal', 'wait', '--terminal=term_1', '--for=tui-idle', '--timeout-ms=120000', '--json']
    ])
    expect(replies.find((reply) => reply.id === 1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{"ok":true,"result":{"sent":true}}' }],
        isError: false
      }
    })
  })

  it('negotiates the protocol and lists the tools with server instructions', async () => {
    const server = startServer(replyWith({ exitCode: 0, stdout: '', stderr: '' }))
    server.request({
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } }
    })
    server.request({ method: 'notifications/initialized' })
    server.request({ id: 'list', method: 'tools/list' })
    server.request({ id: 'other', method: 'resources/list' })
    const [init, list, other] = await server.close()

    expect(init).toMatchObject({
      id: 'init',
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orca', version: '9.9.9' }
      }
    })
    expect(init).toMatchObject({
      result: { instructions: expect.stringContaining('idle agent is not dead') }
    })
    expect(list).toMatchObject({
      result: {
        tools: [
          { name: 'orca_status' },
          { name: 'worktree_list' },
          { name: 'worktree_ps' },
          { name: 'worktree_create' },
          { name: 'agent_launch' },
          { name: 'terminal_list' },
          { name: 'terminal_read' },
          { name: 'terminal_send' },
          { name: 'terminal_wait' },
          { name: 'orchestration_run_list' },
          { name: 'orchestration_task_list' }
        ]
      }
    })
    expect(other).toEqual({
      jsonrpc: '2.0',
      id: 'other',
      error: { code: -32601, message: 'Method not found: resources/list' }
    })
  })

  it('reports CLI failures and refused sends as tool errors but keeps an unmet wait a success', async () => {
    const failure = '{"ok":false,"error":{"code":"runtime_unavailable","message":"down"}}'
    const runs: McpToolRun[] = [
      { exitCode: 1, stdout: `${failure}\n`, stderr: 'Start Orca first.\n' },
      { exitCode: 1, stdout: '{"ok":true,"result":{"wait":{"satisfied":false}}}', stderr: '' },
      { exitCode: 1, stdout: '{"ok":true,"result":{"accepted":false}}', stderr: '' }
    ]
    const server = startServer(async () => runs.shift()!)
    server.request({ id: 1, method: 'tools/call', params: { name: 'orca_status' } })
    server.request({
      id: 2,
      method: 'tools/call',
      params: { name: 'terminal_wait', arguments: { terminal: 't', for: 'exit', timeoutMs: 10 } }
    })
    server.request({
      id: 3,
      method: 'tools/call',
      params: {
        name: 'terminal_wait',
        arguments: { terminal: 't', for: 'exit', timeoutMs: 10 ** 6 }
      }
    })
    server.request({
      id: 4,
      method: 'tools/call',
      params: { name: 'terminal_send', arguments: { terminal: 't', text: 'hi' } }
    })
    const replies = await server.close()
    const byId = (id: number) => replies.find((reply) => reply.id === id)?.result

    expect(byId(1)).toEqual({
      content: [{ type: 'text', text: `${failure}\nStart Orca first.` }],
      isError: true
    })
    expect(byId(2)).toMatchObject({ isError: false })
    expect(byId(3)).toEqual({
      content: [{ type: 'text', text: 'terminal_wait: "timeoutMs" must be at most 120000.' }],
      isError: true
    })
    expect(byId(4)).toMatchObject({ isError: true })
  })

  it('aborts a cancelled call without answering it', async () => {
    let aborted = false
    const server = startServer(
      (_tool, _argv, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve({ exitCode: null, stdout: '', stderr: '' })
          })
        })
    )
    server.request({
      id: 7,
      method: 'tools/call',
      params: { name: 'terminal_wait', arguments: { terminal: 't', for: 'tui-idle' } }
    })
    server.request({ method: 'notifications/cancelled', params: { requestId: 7 } })
    server.request({ id: 8, method: 'ping' })
    const replies = await server.close()

    expect(aborted).toBe(true)
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 8, result: {} }])
  })
})
