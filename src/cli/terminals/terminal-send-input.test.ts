import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../arguments/args'
import { RuntimeClient } from '../runtime/client'
import { terminalSendHandler } from './terminal-send'

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

describe('terminal send payload sources', () => {
  let cwd: string
  let client: RuntimeClient
  let server: Server
  let requests: { params: unknown; orchestrationRequestId?: string }[]
  const sockets = new Set<Socket>()

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-terminal-send-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    requests = []
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\${basename(cwd)}` : join(cwd, 'runtime.sock')
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.setEncoding('utf8')
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString()
        if (!data.includes('\n')) {
          return
        }
        const request = JSON.parse(data)
        if (request.method === 'terminal.send') {
          requests.push(request)
        }
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            _meta: { runtimeId: 'runtime-1' },
            result:
              request.method === 'status.get'
                ? {
                    runtimeId: 'runtime-1',
                    graphStatus: 'ready',
                    capabilities: ['terminal.prompt-delivery.v1']
                  }
                : {
                    send: {
                      handle: 'term-1',
                      accepted: true,
                      bytesWritten: 1,
                      prompt: { stages: ['input_accepted', 'turn_started'] }
                    }
                  }
          })}\n`
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    await writeFile(
      join(cwd, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }],
        authToken: 'test-token',
        startedAt: 1
      })
    )
    client = new RuntimeClient(cwd, 5_000, null, null)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin)
    }
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(cwd, { recursive: true, force: true })
  })

  function send(argv: string[]) {
    const parsed = parseArgs(['terminal', 'send', '--terminal', 'term-1', ...argv])
    return terminalSendHandler({ flags: parsed.flags, client, cwd, json: true })
  }

  it('reads stdin until EOF and forwards UTF-8, whitespace and control bytes verbatim', async () => {
    const input = Readable.from([
      Buffer.from([0x20, 0xc3]),
      Buffer.from([0xa1, 0x0d, 0x0a, 0x1b, 0x15, 0x00, 0x0a])
    ])
    Object.defineProperty(process, 'stdin', { configurable: true, value: input })
    await send(['--text', '-'])

    expect(requests).toMatchObject([
      {
        params: {
          terminal: 'term-1',
          text: ' á\r\n\x1b\x15\0\n',
          enter: false,
          interrupt: false,
          client: { id: 'orca-cli', type: 'desktop' }
        }
      }
    ])
  })

  it('reads a file relative to cwd and uses the existing prompt submission and retry flow', async () => {
    await writeFile(join(cwd, 'prompt.txt'), '  Olá\r\n\x1b\x15\n')
    await send([
      '--text-file',
      'prompt.txt',
      '--enter',
      '--wait-submit',
      '3',
      '--retry-request',
      '11111111-1111-4111-8111-111111111111'
    ])

    expect(requests).toMatchObject([
      {
        params: {
          terminal: 'term-1',
          text: '  Olá\r\n\x1b\x15\n',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          waitSubmitMs: 3_000,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        orchestrationRequestId: '11111111-1111-4111-8111-111111111111'
      }
    ])
  })

  it('reads an absolute file path and preserves raw control bytes with interrupt', async () => {
    await writeFile(join(cwd, 'input.txt'), '\x1b\x15\0\r\n')

    await send(['--text-file', join(cwd, 'input.txt'), '--interrupt'])

    expect(requests).toMatchObject([
      { params: { text: '\x1b\x15\0\r\n', enter: false, interrupt: true } }
    ])
  })

  it('treats empty stdin with --enter like empty inline text', async () => {
    const input = Readable.from([])
    Object.defineProperty(process, 'stdin', { configurable: true, value: input })

    await send(['--text', '-', '--enter'])

    expect(requests).toMatchObject([{ params: { enter: true, interrupt: false } }])
    expect(requests[0].params).not.toHaveProperty('agentPrompt')
    expect(requests[0].params).not.toHaveProperty('text')
  })

  it.each(['inline', '-', ''])(
    'rejects conflicting sources (--text %j) before reading input',
    async (text) => {
      await expect(send(['--text', text, '--text-file', 'missing.txt'])).rejects.toMatchObject({
        code: 'invalid_argument'
      })
    }
  )

  it('rejects a missing file path', async () => {
    await expect(send(['--text-file'])).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('reports unreadable files instead of sending the filename as text', async () => {
    await expect(send(['--text-file', 'missing.txt'])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects interactive stdin instead of waiting for terminal input', async () => {
    const input = Object.assign(Readable.from([]), { isTTY: true })
    Object.defineProperty(process, 'stdin', { configurable: true, value: input })

    await expect(send(['--text', '-'])).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})
