import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import {
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentConnectionOptions
} from './acp-agent-connection'
import { AcpAgentExitedError, AcpAuthRequiredError } from './acp-errors'
import { acpStartFailure } from './acp-startup-outcome'
import captures from '../native-chat/agent-session-wire/__fixtures__/startup-protocol-rejections.json'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'

const teardown = vi.hoisted(() =>
  vi.fn<typeof terminateProviderProcessTree>(async () => 'unverifiable')
)
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))
await vi.importActual<{
  terminateProviderProcessTree: typeof terminateProviderProcessTree
}>('../provider-process/provider-process-teardown')

const opened: { connection: AcpAgentConnection; exit: () => void }[] = []
const grace =
  process.platform === 'win32' ? ROOT_ONLY_GRACEFUL_EXIT_MS : PROVIDER_SUPERVISOR_MAX_STOP_MS
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

  it('reports broken stdin immediately but reports exit only after the host observes it', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onExit = vi.fn()
    const { connection, child } = fixture({ onClose, onExit }, { exitOnEnd: false })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('broken pipe')
    child.stdin.emit('error', new Error('broken pipe'))
    child.emit('close', 0, null)
    // The call waits the drain bound for an answer the agent may already have written.
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
    expect(connection.closed).toBe(true)
    expect(connection.rootVerdict).toBe('live')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit.mock.calls[0][1].expected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends notification draining at the bounded close result even when exit remains unproven', async () => {
    vi.useFakeTimers()
    const onExtensionNotification = vi.fn()
    const { connection, agent } = fixture({ onExtensionNotification }, { exitOnEnd: false })
    await connection.start(start)
    const closing = connection.close()
    expect(connection.closed).toBe(true)
    agent.notify('_x.ai/session/update', { outcome: 'before-exit' })
    expect(onExtensionNotification).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(grace + 1_000)
    expect(await closing).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    agent.notify('_x.ai/session/update', { outcome: 'after-unproven-close' })
    expect(onExtensionNotification).toHaveBeenCalledOnce()
    expect(agent.stdout.listenerCount('data')).toBe(0)
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

it.each([true, false])(
  'settles a typed session response synchronously before the following stdout sign-in line (valid=%s)',
  async (valid) => {
    const answers: boolean[] = []
    const { connection, agent } = fixture({
      signIn: {
        read: (line) => (line.startsWith('SIGN IN') ? 'fixture-link' : undefined),
        answered: (answer) => answers.push(answer)
      }
    })
    agent.on('session/new', (frame) =>
      agent.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: valid ? { sessionId: 'accepted-session' } : {} })}\nSIGN IN fixture-link\n`
      )
    )
    const result = await connection.start(start).catch((error: unknown) => error)
    expect(answers).toEqual(valid ? [true, false] : [false])
    if (valid) {
      expect(result).toMatchObject({ sessionId: 'accepted-session' })
    } else {
      expect(result).toBeInstanceOf(Error)
    }
    expect(connection.closed).toBe(true)
  }
)

it('closes a recognized stdout prompt over 16 MiB without inventing a signed-out answer', async () => {
  const answered = vi.fn()
  const { connection, agent } = fixture({
    signIn: {
      read: (line) => (line.startsWith('SIGN IN') ? 'prefix-only' : undefined),
      answered
    }
  })
  await connection.start(start)
  expect(answered).toHaveBeenCalledExactlyOnceWith(true)
  agent.stdout.write(`SIGN IN ${'x'.repeat(16 * 1024 * 1024)}\n`)
  await vi.waitFor(() => expect(connection.closed).toBe(true))
  expect(answered).toHaveBeenCalledTimes(1)
})
