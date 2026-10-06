import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { SUPERVISED_PROVIDER_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-supervisor'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import {
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentConnectionOptions
} from './acp-agent-connection'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'

const UNOBSERVED = { tree: 'unverifiable', providerKilled: false } as const
const teardown = vi.hoisted(() =>
  vi.fn<typeof terminateProviderProcessTree>(async () => UNOBSERVED)
)
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))

const opened: { connection: AcpAgentConnection; exit: () => void }[] = []
const grace =
  process.platform === 'win32' ? ROOT_ONLY_GRACEFUL_EXIT_MS : SUPERVISED_PROVIDER_GRACEFUL_EXIT_MS
const start = { cwd: '/execution-host/folder', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const

function fixture(
  options: AcpAgentConnectionOptions = {},
  behavior: { pid?: number | null; exitOnEnd?: boolean } = {}
) {
  const agent = new AcpScriptedAgent()
  const child = Object.assign(new EventEmitter(), {
    pid: behavior.pid === null ? undefined : (behavior.pid ?? 9_999_999),
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<typeof spawnProcess>(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The supervised connection reads events, pid, piped stdio and kill; this fixture supplies each.
    return child as unknown as ReturnType<typeof spawnProcess>
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
      cwd: start.cwd,
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
  teardown.mockReset().mockResolvedValue(UNOBSERVED)
  vi.useRealTimers()
})

describe('ACP process-owning connection', () => {
  it('spawns through the supervisor with the host launch and exposes typed session calls', async () => {
    const { connection, spawn, child, agent } = fixture()
    await connection.spawned
    expect(connection.pid).toBe(child.pid)
    expect(connection.rootVerdict).toBe('live')
    expect(connection.lastCloseResult).toBeNull()
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: start.cwd,
        env: expect.objectContaining({ ACP_ACCOUNT_HOME: '/host/account' }),
        stdio: ['pipe', 'pipe', 'pipe']
      })
    )
    expect(spawn.mock.calls[0][0].env).not.toHaveProperty('STRIPPED')
    expect(await connection.start(start)).toMatchObject({ sessionId: 'session-1' })
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    expect(await connection.prompt([...prompt])).toEqual({ stopReason: 'end_turn' })
    connection.pauseReading()
    expect(child.stdout.isPaused()).toBe(true)
    connection.resumeReading()
    expect(child.stdout.isPaused()).toBe(false)
    expect(await connection.close()).toBe(true)
    expect(connection.lastCloseResult).toEqual({
      root: 'exited',
      tree: null,
      providerKilled: false
    })
  })

  it('settles prompts and permission signals on proven exit with stdout still open', async () => {
    const onExit = vi.fn()
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
    const late = vi.fn()
    connection.onExit(late)
    expect(late).toHaveBeenCalledOnce()
    await expect(connection.close()).resolves.toBe(true)
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

  it('joins physical close and retries unproven exit without spawning a replacement', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const { connection, child, spawn } = fixture({ onExit }, { exitOnEnd: false })
    const first = connection.close()
    const joined = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 1_000)
    expect(await first).toBe(false)
    expect(await joined).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    expect(teardown).toHaveBeenCalledOnce()
    teardown.mockImplementationOnce(async () => {
      child.emit('exit', null, 'SIGKILL')
      return UNOBSERVED
    })
    const retry = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 1_000)
    expect(await retry).toBe(true)
    expect(connection.processTreeUnproven).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(onExit.mock.calls[0][1].expected).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['live', 'unverifiable'] as const)(
    'retains %s tree evidence when root exits between completed close attempts',
    async (tree) => {
      vi.useFakeTimers()
      const { connection, child } = fixture({}, { exitOnEnd: false })
      teardown.mockResolvedValueOnce({ tree, providerKilled: false })
      const close = connection.close()
      await vi.advanceTimersByTimeAsync(grace + 1_000)
      expect(await close).toBe(false)
      child.emit('exit', null, 'SIGKILL')
      expect(connection.processTreeUnproven).toBe(true)
      expect(await connection.close()).toBe(true)
      expect(connection.processTreeUnproven).toBe(true)
      expect(connection.lastCloseResult).toEqual({ root: 'live', tree, providerKilled: false })
      expect(teardown).toHaveBeenCalledOnce()
    }
  )

  it('isolates early and late exit subscribers and continues delivering exit', () => {
    const onDiagnostic = vi.fn(() => {
      throw new Error('diagnostic')
    })
    const { connection, child } = fixture({ onDiagnostic })
    const failing = (): void => {
      throw new Error('observer')
    }
    const early = vi.fn()
    connection.onExit(failing)
    connection.onExit(early)
    expect(() => child.emit('exit', 0, null)).not.toThrow()
    expect(early).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null, processless: false })
    expect(() => connection.onExit(failing)).not.toThrow()
    const late = vi.fn()
    connection.onExit(late)
    expect(late).toHaveBeenCalledOnce()
    expect(onDiagnostic).toHaveBeenCalledTimes(2)
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

  it('owns stderr failure cleanup and isolates failing exit callbacks', async () => {
    const { connection, child } = fixture({
      onExit: () => {
        throw new Error('listener')
      }
    })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('stderr failure')
    child.stderr.destroy(new Error('stderr failure'))
    await rejected
    await tick()
    expect(connection.exited).toBe(true)
    expect(await connection.close()).toBe(true)
  })

  it('rejects invalid peer options before starting any process', () => {
    const spawn = vi.fn<typeof spawnProcess>()
    expect(() =>
      createAcpAgentConnection(
        { command: 'fixture', args: [] },
        { peer: { maxPendingRequests: 0 } },
        spawn
      )
    ).toThrow('positive finite integers')
    expect(spawn).not.toHaveBeenCalled()
  })
})
