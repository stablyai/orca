import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import type { terminateProviderProcessTree } from '../../provider-process/provider-process-teardown'
import {
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentConnectionOptions
} from './acp-agent-connection'
import { AcpAgentExitedError, AcpAuthRequiredError } from '../transport/acp-errors'
import { acpStartFailure } from '../session/start/acp-startup-outcome'
import captures from '../../native-chat/agent-session-wire/__fixtures__/startup-protocol-rejections.json'
import { AcpScriptedAgent, deferred, tick } from './testing/acp-scripted-agent.test-support'

const teardown = vi.hoisted(() =>
  vi.fn<typeof terminateProviderProcessTree>(async () => 'unverifiable')
)
vi.mock('../../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))
await vi.importActual<{
  terminateProviderProcessTree: typeof terminateProviderProcessTree
}>('../../provider-process/provider-process-teardown')

const opened: { connection: AcpAgentConnection; exit: () => void }[] = []

const start = { cwd: '/execution-host/folder', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const

function fixture(
  options: AcpAgentConnectionOptions = {},
  behavior: { pid?: number | null; exitOnEnd?: boolean; cwd?: string } = {}
) {
  const agent = new AcpScriptedAgent()
  const child = Object.assign(createFakePipedChild(), {
    pid: behavior.pid === null ? undefined : (behavior.pid ?? 9_999_999),
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  if (behavior.exitOnEnd !== false) {
    child.stdin.once('finish', () => child.emit('exit', 0, null))
  }
  const connection = createAcpAgentConnection(
    {
      command: 'fixture-acp-agent',
      args: ['--acp'],
      cwd: behavior.cwd ?? start.cwd,
      env: { ACP_ACCOUNT_HOME: '/host/account', STRIPPED: 'overlay' },
      envToDelete: ['STRIPPED']
    },
    options,
    spawn
  )
  opened.push({ connection, exit: () => child.emit('exit', 0, null) })
  return { agent, child, spawn, connection }
}

afterEach(async () => {
  for (const { connection, exit } of opened.splice(0)) {
    exit()
    await connection.close()
  }
  teardown.mockReset().mockResolvedValue('unverifiable')
  vi.useRealTimers()
})

describe('ACP process-owning connection', () => {
  // The supervisor (POSIX only) reports the failed spawn on stderr and exits 127.

  it('settles prompts and permission signals on proven exit with stdout still open', async () => {
    const statusDuringExit: unknown[] = []
    const onExit = vi.fn(() => statusDuringExit.push(connection.exitStatus))
    const onClose = vi.fn()
    const permission = deferred<AbortSignal>()
    const { connection, child, agent } = fixture({
      onExit,
      onClose,
      onPermission: (_request, context) => {
        permission.resolve(context.signal)
        return new Promise(() => {})
      }
    })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('provider failed')
    void agent.request('approval', 'session/request_permission', {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
    })
    const signal = await permission.promise
    child.stderr.write('provider failed\n')
    child.emit('exit', 7, null)
    child.emit('close', 7, null)
    await rejected
    expect(signal.aborted).toBe(true)
    expect(child.stdout.readableEnded).toBe(false)
    expect(connection.exited).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      expected: false,
      exit: { code: 7, signal: null, processless: false }
    })
    expect(statusDuringExit).toEqual([{ code: 7, signal: null, processless: false }])
    const late = vi.fn()
    connection.onExit(late)
    expect(late).toHaveBeenCalledOnce()
    await expect(connection.close()).resolves.toBe(true)
  })

  it('ends a turn signed out at a sign-in prompt line and never retains its URL', async () => {
    const said: string[] = []
    const onExit = vi.fn((error: Error) => said.push(error.message))
    const { connection, child } = fixture({
      onExit,
      onDiagnostic: (message) => said.push(message),
      signIn: {
        read: (line) =>
          line.startsWith('Open the following link to authenticate') ? 'link' : undefined
      }
    })
    await connection.start(start)
    const turn = connection.prompt([...prompt]).catch((error: unknown) => error)
    child.stderr.write(
      `warming up\nOpen the following link to authenticate the ACP server: https://accounts.example/auth?state=${'x'.repeat(8192)}`
    )
    child.stderr.write('s3cret\n')
    const error = await turn
    expect(error).toBeInstanceOf(AcpAuthRequiredError)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    said.push(String(error), connection.stderrTail())
    expect(connection.stderrTail()).toBe('warming up')
    expect(said.join('\n')).not.toMatch(/s3cret|accounts\.example/)
  })

  it('drops an overlong stderr line it could not classify instead of keeping its prefix', async () => {
    const { connection, child } = fixture({
      signIn: {
        read: (line) => (line.endsWith('authenticate') ? 'link' : undefined)
      }
    })
    await connection.start(start)
    const link = `https://accounts.example/auth?state=${'x'.repeat(33_000)}`
    child.stderr.write(`warming up\nplease visit ${link}`)
    child.stderr.write('s3cret\nready\n')
    await vi.waitFor(() => expect(connection.stderrTail()).toContain('ready'))
    expect(connection.stderrTail()).toBe('warming up\nready')
  })

  it('keeps cancel writable after stdout EOF and waits for process exit evidence', async () => {
    const onClose = vi.fn()
    const onExit = vi.fn()
    const { connection, child, agent } = fixture({ onClose, onExit })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('connection closed')
    child.stdout.end()
    await tick()
    expect(connection.closed).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    await connection.cancel()
    expect(agent.frames.at(-1)?.method).toBe('session/cancel')
    expect(onClose).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(await connection.close()).toBe(true)
    await rejected
    expect(onExit.mock.calls[0][1].expected).toBe(true)
  })

  it('keeps the final answer an agent wrote just before it exited, and only then reads its exit', async () => {
    const { response } = captures.acp
    const onExit = vi.fn()
    const { connection, agent, child } = fixture({ onExit }, { exitOnEnd: false })
    // The recorded refusal answers this start's session request just after the agent exited.
    agent.on('session/new', (frame) => {
      child.emit('exit', 0, null)
      setImmediate(() => agent.send({ ...response, jsonrpc: '2.0', id: frame.id }))
    })
    const loaded = connection.start(start).catch((error: unknown) => error)
    expect(await loaded).toMatchObject({ code: response.error.code, data: response.error.data })
    expect(acpStartFailure(await loaded).retry).toBe('never')
    agent.stdout.end()
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce())
  })

  it('answers an unanswered call with the drained exit, which may start once more', async () => {
    const { connection, agent, child } = fixture({}, { exitOnEnd: false })
    agent.on('session/new', () => {
      child.emit('exit', 1, null)
      agent.stdout.end()
    })
    const loaded = connection.start(start).catch((error: unknown) => error)
    expect(await loaded).toBeInstanceOf(AcpAgentExitedError)
    expect(acpStartFailure(await loaded).retry).toBe('safe')
  })

  it('settles a failed spawn but requires processless close evidence before reporting exit', async () => {
    const onExit = vi.fn()
    const { connection, child, agent } = fixture({ onExit }, { pid: null, exitOnEnd: false })
    agent.on('initialize', () => {})
    const rejected = expect(connection.initialize()).rejects.toThrow('ENOENT')
    child.emit('error', new Error('ENOENT'))
    await connection.spawned
    await rejected
    expect(connection.rootVerdict).toBe('unverifiable')
    expect(onExit).not.toHaveBeenCalled()
    child.emit('close', null, null)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit.mock.calls[0][1].exit.processless).toBe(true)
    expect(await connection.close()).toBe(true)
  })
})

it('keeps cached startup usable without advertising the configured method, but refuses unsupported required authentication', async () => {
  const { connection, agent } = fixture()
  agent.on('initialize', (frame) =>
    agent.reply(frame, {
      protocolVersion: 1,
      authMethods: [{ id: 'oauth-personal', name: 'Google account' }]
    })
  )
  const configured = {
    ...start,
    authMethodId: 'oauth-business',
    authMethodUnavailableMessage:
      'Antigravity account type is unavailable. Update Antigravity or change account settings.'
  }
  await expect(connection.start(configured)).resolves.toMatchObject({ sessionId: 'session-1' })
  const required = fixture()
  required.agent.on('initialize', (frame) =>
    required.agent.reply(frame, {
      protocolVersion: 1,
      authMethods: [{ id: 'oauth-personal', name: 'Google account' }]
    })
  )
  required.agent.on('session/new', (frame) =>
    required.agent.fail(frame, -32000, 'Authentication required')
  )
  await expect(required.connection.start(configured)).rejects.toThrow(
    'Antigravity account type is unavailable'
  )
  expect(required.agent.frames.filter((frame) => frame.method === 'authenticate')).toEqual([])
})

it('keeps a genuine auth answer drained after spontaneous exit while rejecting later stopped-owner output', async () => {
  const answered = vi.fn()
  const { connection, agent, child } = fixture({
    signIn: { read: (line) => (line === 'SIGN IN' ? 'link' : undefined), answered }
  })
  agent.on('session/new', (frame) => {
    child.emit('exit', 0, null)
    agent.reply(frame, { sessionId: 'final-session' })
  })
  await expect(connection.start(start)).resolves.toMatchObject({ sessionId: 'final-session' })
  expect(answered).toHaveBeenCalledWith(true)
  await connection.close()
  answered.mockClear()
  child.stderr.write('SIGN IN\n')
  await tick()
  expect(answered).not.toHaveBeenCalled()
})
