import { ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  SourceControlAgentSpawnInput,
  SpawnedSourceControlAgentProcess
} from '../text-generation/source-control-text-generation-types'
import { OpenCodeTextTaskError, runOwnedOpenCodeTextTask } from './opencode-owned-text-task'
import { runOpenCodeTextTaskSession } from './opencode-text-task-session'
import type * as TextTaskSession from './opencode-text-task-session'

vi.mock('./opencode-text-task-session', () => ({ runOpenCodeTextTaskSession: vi.fn() }))
const actual = await vi.importActual<typeof TextTaskSession>('./opencode-text-task-session')

type FakeChild = SpawnedSourceControlAgentProcess & {
  input: SourceControlAgentSpawnInput
  stdout: PassThrough
}

function fakeChild(input: SourceControlAgentSpawnInput): FakeChild {
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdout: { writable: true, configurable: true, enumerable: true },
    stderr: { writable: true, configurable: true, enumerable: true },
    stdin: { writable: true, configurable: true, enumerable: true }
  })
  return Object.assign(child, {
    input,
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
}

function close(child: SpawnedSourceControlAgentProcess, code = 0): void {
  Object.assign(child, { exitCode: code })
  child.emit('close', code)
}

/** A CLI whose `--version` prints `version`; v2 serve exits on stdin end, v1 serve only when stopped. */
function fakeOpenCode(version: string) {
  const children: FakeChild[] = []
  const spawn = vi.fn((input: SourceControlAgentSpawnInput) => {
    const child = fakeChild(input)
    children.push(child)
    if (input.args.includes('--version')) {
      setImmediate(() => {
        child.stdout.write(`${version}\n`)
        close(child)
      })
    } else if (input.args.includes('--stdio')) {
      child.stdin?.on('finish', () => setImmediate(() => close(child)))
      setImmediate(() => child.stdout.write('{"url":"http://127.0.0.1:4096/"}\n'))
    } else {
      setImmediate(() => child.stdout.write('opencode server listening on http://127.0.0.1:4097\n'))
    }
    return child
  })
  const stop = vi.fn(async (child: SpawnedSourceControlAgentProcess) => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    close(child, 143)
  })
  return { children, spawn, stop }
}

let cwd = 0
function task(cli: ReturnType<typeof fakeOpenCode>, signal = new AbortController().signal) {
  return {
    binary: '/opt/opencode/bin/opencode',
    prefixArgs: ['--print-logs'],
    // A distinct cwd keeps the shared version-probe cache from crossing tests.
    cwd: `/work/repo-${++cwd}`,
    env: { PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: '{"provider":{}}' },
    prompt: 'Name this chat',
    runArgs: ['--agent', 'title'],
    signal,
    spawn: cli.spawn,
    stop: cli.stop
  }
}

describe('runOwnedOpenCodeTextTask', () => {
  it('runs the selected v2 choices on its own stdio server and returns after that server exits', async () => {
    const cli = fakeOpenCode('2.0.14')
    vi.mocked(runOpenCodeTextTaskSession).mockImplementationOnce(async () => {
      expect(cli.children[1].exitCode).toBeNull()
      return 'Harbor Lantern'
    })
    const base = task(cli)
    const input = { ...base, runArgs: [...base.runArgs, '--model', 'opencode/big-pickle#high'] }

    await expect(runOwnedOpenCodeTextTask(input)).resolves.toBe('Harbor Lantern')

    const server = cli.children[1]
    expect(server.input.args).toEqual(['--print-logs', 'serve', '--stdio', '--port', '0'])
    expect(server.input.cwd).toBe(input.cwd)
    expect(server.input.env).toMatchObject({
      OPENCODE_CONFIG_CONTENT: '{"provider":{}}',
      OPENCODE_PASSWORD: expect.any(String)
    })
    expect(vi.mocked(runOpenCodeTextTaskSession).mock.calls[0][0]).toMatchObject({
      version: 'v2',
      url: 'http://127.0.0.1:4096',
      directory: input.cwd,
      prompt: 'Name this chat',
      agent: 'title',
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      variant: 'high'
    })
    expect(server.exitCode).toBe(0)
    expect(cli.stop).not.toHaveBeenCalled()
  })

  it('stops a v1 foreground server on cancel and rejects only once it has exited', async () => {
    const cli = fakeOpenCode('1.18.31')
    const controller = new AbortController()
    vi.mocked(runOpenCodeTextTaskSession).mockImplementationOnce(async ({ signal }) => {
      controller.abort(new Error('canceled by user'))
      throw signal.reason
    })

    await expect(runOwnedOpenCodeTextTask(task(cli, controller.signal))).rejects.toThrow(
      'canceled by user'
    )

    const server = cli.children[1]
    expect(server.input.args).toEqual([
      '--print-logs',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0'
    ])
    expect(server.input.env).toHaveProperty('OPENCODE_SERVER_PASSWORD')
    expect(cli.stop).toHaveBeenCalledWith(server)
    expect(server.exitCode).toBe(143)
  })

  it('never starts a server for an executable whose protocol is unknown', async () => {
    const cli = fakeOpenCode('opencode development build')

    const error = await runOwnedOpenCodeTextTask(task(cli)).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OpenCodeTextTaskError)
    expect(error).toMatchObject({ stage: 'startup' })
    expect(cli.children.map((child) => child.input.args)).toEqual([['--print-logs', '--version']])
  })
  it.each([
    ['1.2.27', 'conversation-name', true],
    ['1.3.0-beta.1', 'commit-message', true],
    ['1.3.0+build.7', 'commit-message', false],
    ['1.18.31', 'conversation-name', false]
  ] as const)(
    'authenticates V1 %s and preserves its acknowledged policy for %s',
    async (version, operation, rejectsPermission) => {
      vi.mocked(runOpenCodeTextTaskSession).mockImplementationOnce(
        actual.runOpenCodeTextTaskSession
      )
      const cli = fakeOpenCode(version)
      let rejected = false
      let events: ServerResponse | undefined
      let completion: ServerResponse | undefined
      const spawn = vi.fn((input: SourceControlAgentSpawnInput) => {
        if (!input.args.includes('serve')) {
          return cli.spawn(input)
        }
        const child = fakeChild(input)
        // As the native server does: the configured username and password must both match.
        const credential = `${input.env?.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${input.env?.OPENCODE_SERVER_PASSWORD}`
        const finish = () => {
          completion!
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] }))
        }
        const server = createServer(async (request, response) => {
          if (
            request.headers.authorization !== `Basic ${Buffer.from(credential).toString('base64')}`
          ) {
            response.writeHead(401).end()
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk))
          }
          const content = Buffer.concat(chunks).toString('utf8')
          const body = content ? JSON.parse(content) : undefined
          const path = request.url?.split('?')[0]
          let result: unknown = {}
          if (request.method === 'POST' && path === '/session') {
            result = {
              id: 'ses_1',
              permission: [
                { permission: '*', pattern: '*', action: 'deny' },
                { permission: 'read', pattern: '*', action: 'allow' },
                { permission: 'grep', pattern: '*', action: 'allow' },
                { permission: 'glob', pattern: '*', action: 'allow' },
                { permission: 'external_directory', pattern: '*', action: 'allow' },
                { permission: 'read', pattern: 'mcp:*', action: 'deny' }
              ]
            }
          } else if (path === '/agent') {
            result = [{ name: 'title', mode: 'primary' }]
          } else if (path === '/event') {
            events = response
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.flushHeaders()
            return
          } else if (path === '/session/ses_1/message') {
            expect(body).toMatchObject({
              agent: 'title',
              parts: [{ type: 'text', text: 'Name this chat' }]
            })
            expect(body).not.toHaveProperty('tools')
            completion = response
            if (rejectsPermission) {
              for (const sessionID of ['foreign', 'ses_1']) {
                events!.write(
                  `data: ${JSON.stringify({ type: 'permission.updated', properties: { sessionID, id: 'per_write' } })}\n\n`
                )
              }
            } else {
              expect(events).toBeUndefined()
              finish()
            }
            return
          } else if (path === '/session/ses_1/permissions/per_write') {
            expect(body).toEqual({ response: 'reject' })
            rejected = true
            finish()
          } else if (path === '/session/foreign/permissions/per_write') {
            throw new Error('Borrowed permission must not be answered')
          }
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
        })
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          const port = address && typeof address === 'object' ? address.port : 0
          child.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`)
        })
        child.once('close', () => server.close())
        return child
      })
      const input = {
        ...task({ ...cli, spawn }),
        operation,
        env: { PATH: '/usr/bin', OPENCODE_SERVER_USERNAME: 'custom' }
      }
      await expect(runOwnedOpenCodeTextTask(input)).resolves.toBe('Harbor Lantern')
      expect(rejected).toBe(rejectsPermission)
    }
  )
})

it.each(['v1', 'v2'] as const)(
  'uses the selected external naming server’s protocol and URL (%s)',
  async (version) => {
    const server = createServer((request, response) => {
      if (request.url !== (version === 'v1' ? '/prefix/global/health' : '/api/info')) {
        response.statusCode = 400
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          version: version === 'v1' ? '1.2.27' : '2.0.14',
          pid: 23,
          urls: [],
          paths: { tmp: '/tmp' }
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No endpoint')
      }
      const url = `http://127.0.0.1:${address.port}`
      const cli = fakeOpenCode('1.18.31')
      vi.mocked(runOpenCodeTextTaskSession).mockResolvedValueOnce('Harbor Lantern')
      const input = {
        ...task(cli),
        operation: 'conversation-name' as const,
        runArgs: [
          version === 'v1' ? '--attach' : '--server',
          `${url}/prefix/`,
          '--session',
          'saved',
          '--model',
          'provider/model',
          '--variant',
          'high'
        ],
        legacyVariantFlag: true
      }
      await expect(runOwnedOpenCodeTextTask(input)).resolves.toBe('Harbor Lantern')
      expect(cli.spawn).not.toHaveBeenCalled()
      expect(cli.stop).not.toHaveBeenCalled()
      expect(vi.mocked(runOpenCodeTextTaskSession).mock.lastCall?.[0]).toMatchObject({
        version,
        url: `${url}/prefix`,
        sessionId: 'saved',
        model: { providerID: 'provider', modelID: 'model' },
        variant: 'high',
        exclusiveServer: false,
        v1SessionPolicyFiltersTools: false
      })
      if (version === 'v2') {
        await expect(
          runOwnedOpenCodeTextTask({ ...input, legacyVariantFlag: false })
        ).rejects.toMatchObject({ stage: 'startup' })
      }
      await expect(
        runOwnedOpenCodeTextTask({ ...input, operation: 'commit-message' })
      ).rejects.toMatchObject({ stage: 'startup' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)

it('suppresses implicit publication before owned startup while retaining explicit share configuration', async () => {
  for (const share of [false, true]) {
    const cli = fakeOpenCode('1.18.31')
    vi.mocked(runOpenCodeTextTaskSession).mockResolvedValueOnce('Harbor Lantern')
    const input = {
      ...task(cli),
      operation: 'conversation-name' as const,
      runArgs: share ? ['--share'] : [],
      env: { OPENCODE_DISABLE_SHARE: 'user-value', OPENCODE_CONFIG_CONTENT: '{"share":"auto"}' }
    }
    await expect(runOwnedOpenCodeTextTask(input)).resolves.toBe('Harbor Lantern')
    expect(cli.children[1].input.env).toMatchObject({
      OPENCODE_DISABLE_SHARE: share ? 'user-value' : '1',
      OPENCODE_CONFIG_CONTENT: '{"share":"auto"}'
    })
    expect(cli.children[1].exitCode).not.toBeNull()
  }
})
