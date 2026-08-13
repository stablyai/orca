import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawn } from 'node:child_process'
import {
  openClaudeStreamJsonConnection,
  type ClaudeControlRequest
} from './claude-stream-json-connection'

type FakeChild = EventEmitter & {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeSpawn() {
  const child = new EventEmitter() as FakeChild
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  const spawnMock = vi.fn(
    (_command: string, _args: readonly string[], _options: { env?: NodeJS.ProcessEnv }) => child
  )
  const spawnImpl = spawnMock as unknown as typeof spawn
  return { child, spawnImpl, spawnMock }
}

function writtenFrames(child: FakeChild): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    setImmediate(() => {
      const text = child.stdin.read()?.toString('utf8') ?? ''
      resolve(
        text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      )
    })
  })
}

describe('Claude stream-json connection', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('spawns in the pinned workspace and routes acknowledged control requests', async () => {
    const process = fakeSpawn()
    const connection = await openClaudeStreamJsonConnection(
      {
        command: 'claude',
        args: ['-p'],
        cwd: '/work/repo',
        env: { CLAUDE_CONFIG_DIR: '/accounts/one' }
      },
      {},
      process.spawnImpl
    )
    const listing = connection.request('list_models')
    const outbound = await writtenFrames(process.child)
    const requestId = (outbound[0] as { request_id: string }).request_id
    process.child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { models: [{ value: 'sonnet' }] }
        }
      })}\n`
    )

    await expect(listing).resolves.toEqual({ models: [{ value: 'sonnet' }] })
    expect(process.spawnImpl).toHaveBeenCalledWith(
      'claude',
      ['-p'],
      expect.objectContaining({
        cwd: '/work/repo',
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/accounts/one' }),
        windowsHide: true
      })
    )
  })

  it('routes provider permission controls and writes their response envelope', async () => {
    const process = fakeSpawn()
    let inbound: ClaudeControlRequest | null = null
    const connection = await openClaudeStreamJsonConnection(
      { command: 'claude', args: [], cwd: '/work' },
      { onControlRequest: (request) => (inbound = request) },
      process.spawnImpl
    )
    process.child.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'permission-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash' }
      })}\n`
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(inbound).toMatchObject({ request_id: 'permission-1' })

    await connection.respond('permission-1', { behavior: 'deny', message: 'No' })
    expect(await writtenFrames(process.child)).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'permission-1',
          response: { behavior: 'deny', message: 'No' }
        }
      }
    ])
  })

  it('forwards unmatched control responses to the provider-frame path', async () => {
    const process = fakeSpawn()
    const onMessage = vi.fn()
    await openClaudeStreamJsonConnection(
      { command: 'claude', args: [], cwd: '/work' },
      { onMessage },
      process.spawnImpl
    )
    const frame = {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'provider-owned', response: { opaque: true } }
    }

    process.child.stdout.write(`${JSON.stringify(frame)}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    expect(onMessage).toHaveBeenCalledWith(frame)
  })

  it('fails closed on malformed provider output', async () => {
    const process = fakeSpawn()
    const onExit = vi.fn()
    const onMessage = vi.fn()
    await openClaudeStreamJsonConnection(
      { command: 'claude', args: [], cwd: '/work' },
      { onExit, onMessage },
      process.spawnImpl
    )
    process.child.stdout.write('{not-json}\n{"type":"assistant"}\n')
    await new Promise((resolve) => setImmediate(resolve))

    expect(process.child.kill).toHaveBeenCalledTimes(1)
    expect(onMessage).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
  })

  it('uses configured auth and strips inherited auth and child-session stamps', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'inherited-session')
    const process = fakeSpawn()

    await openClaudeStreamJsonConnection(
      {
        command: 'claude',
        args: [],
        cwd: '/work',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'configured-token',
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          CLAUDE_CODE_SESSION_ID: 'configured-session'
        }
      },
      {},
      process.spawnImpl
    )

    const env = process.spawnMock.mock.calls[0]?.[2]?.env
    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CODE_SESSION_ID: 'configured-session'
    })
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env?.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
  })

  it('settles concurrent and repeated closes after a spawn failure', async () => {
    const process = fakeSpawn()
    const connection = await openClaudeStreamJsonConnection(
      { command: 'missing-claude', args: [], cwd: '/work' },
      {},
      process.spawnImpl
    )
    process.child.emit('error', new Error('spawn missing-claude ENOENT'))

    await expect(Promise.all([connection.close(), connection.close()])).resolves.toEqual([
      undefined,
      undefined
    ])
    await expect(connection.close()).resolves.toBeUndefined()
  })
})
