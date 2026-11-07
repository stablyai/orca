import { ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  SourceControlAgentSpawnInput,
  SpawnedSourceControlAgentProcess
} from '../text-generation/source-control-text-generation-types'
import { runOwnedOpenCodeTextTask } from './opencode-owned-text-task'
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
