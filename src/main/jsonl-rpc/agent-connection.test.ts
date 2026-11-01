import { Duplex, PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import { JsonlRpcAgentConnection, type JsonlRpcAgentConnectionOptions } from './agent-connection'
import { providerExecutableMissing } from '../provider-process/provider-executable-missing'

const teardown = vi.hoisted(() =>
  vi.fn<typeof terminateProviderProcessTree>(async () => 'unverifiable')
)
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))
const opened: { connection: JsonlRpcAgentConnection; exit: () => void }[] = []
const grace =
  process.platform === 'win32' ? ROOT_ONLY_GRACEFUL_EXIT_MS : PROVIDER_SUPERVISOR_MAX_STOP_MS

function fixture(
  options: JsonlRpcAgentConnectionOptions = {},
  behavior: { exitOnEnd?: boolean; processless?: boolean; cwd?: string } = {}
) {
  const child = Object.assign(createFakePipedChild(), {
    pid: behavior.processless ? undefined : 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const reportInput = new PassThrough()
  const reportOutput = new PassThrough()
  reportOutput.resume()
  child.stdio[3] = Duplex.from({ readable: reportInput, writable: reportOutput })
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  if (behavior.exitOnEnd !== false) {
    child.stdin.once('finish', () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    })
  }
  const connection = new JsonlRpcAgentConnection(
    {
      command: 'fixture-rpc-agent',
      args: ['--mode', 'rpc'],
      cwd: behavior.cwd ?? '/execution-host/folder',
      env: { PI_CODING_AGENT_DIR: '/host/account', STRIPPED: 'overlay' },
      envToDelete: ['STRIPPED']
    },
    options,
    spawn
  )
  opened.push({
    connection,
    exit: () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    }
  })
  return { child, spawn, connection, reportInput }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const { connection, exit } of opened.splice(0)) {
    exit()
    await connection.close()
  }
  teardown.mockReset().mockResolvedValue('unverifiable')
  vi.useRealTimers()
})

describe('JSON-lines RPC process ownership', () => {
  // The supervisor (POSIX only) reports the failed spawn on stderr and exits 127.
  it.skipIf(process.platform === 'win32')(
    'marks the exit of a CLI the supervisor could not spawn as a missing executable',
    async () => {
      const onExit = vi.fn()
      const { connection, child, reportInput } = fixture({ onExit }, { cwd: process.cwd() })
      const pending = connection.request('get_state').catch((error: unknown) => error)
      reportInput.write(
        `${JSON.stringify({ kind: 'failed', thrown: false, error: { name: 'Error', message: 'spawn fixture-rpc-agent ENOENT', code: 'ENOENT' } })}\n`
      )
      await new Promise((resolve) => setImmediate(resolve))
      child.emit('exit', 127, null)
      child.stdout.end()
      child.emit('close', 127, null)
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce())
      expect(providerExecutableMissing(onExit.mock.calls[0][0])).toBe(true)
      expect(providerExecutableMissing(await pending)).toBe(true)
      expect(connection.spawnAbsence).toBe('executable')
    }
  )

  it('uses host-resolved launch data and exposes ordinary RPC replies', async () => {
    const { connection, child, spawn } = fixture()
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: '/execution-host/folder',
        env: expect.objectContaining({ PI_CODING_AGENT_DIR: '/host/account' }),
        stdio: ['pipe', 'pipe', 'pipe', ...(process.platform === 'win32' ? [] : ['pipe'])]
      })
    )
    expect(spawn.mock.calls[0][0].env).not.toHaveProperty('STRIPPED')
    const pending = connection.request('get_state')
    child.stdout.write(
      '{"type":"response","id":"orca-1","command":"get_state","success":true,"data":{"sessionFile":"/host/session.jsonl"}}\n'
    )
    expect(await pending).toEqual({ sessionFile: '/host/session.jsonl' })
    expect(await connection.close()).toEqual({ root: 'exited', tree: null })
  })

  it('settles requests on proven exit with stdout open, and excludes stderr from public errors', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const { connection, child } = fixture({ onExit })
    const pending = expect(connection.request('prompt')).rejects.toThrow('code 7')
    child.stderr.write('sensitive stderr text')
    child.emit('exit', 7, null)
    child.emit('close', 7, null)
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(child.stdout.readableEnded).toBe(false)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      expected: false,
      exit: { code: 7, signal: null, processless: false }
    })
    expect(onExit.mock.calls[0][0].message).not.toContain('sensitive')
  })

  it('drains final response and event bytes written before the root exit', async () => {
    const onRecord = vi.fn()
    const onExit = vi.fn()
    const { connection, child } = fixture({ onRecord, onExit })
    const request = connection.request('get_state')
    child.emit('exit', 0, null)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit).not.toHaveBeenCalled()
    child.stdout.end(
      '{"type":"response","command":"get_state","id":"orca-1","success":true,"data":{}}\n{"type":"agent_settled"}\n'
    )
    await expect(request).resolves.toEqual({})
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({ type: 'agent_settled' })
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('closes a broken stdout transport and cleans up, while keeping host exit evidence separate', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const onClose = vi.fn()
    const { connection, child } = fixture({ onExit, onClose }, { exitOnEnd: false })
    const pending = expect(connection.request('prompt')).rejects.toThrow('stream closed')
    child.stdout.emit('end')
    await pending
    expect(connection.closed).toBe(true)
    expect(connection.rootVerdict).toBe('live')
    expect(onClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    expect(connection.rootVerdict).toBe('exited')
    await connection.close()
  })

  it('preserves the numeric exit when stdout closes first', async () => {
    const onClose = vi.fn(),
      onExit = vi.fn()
    const { connection, child } = fixture({ onClose, onExit }, { exitOnEnd: false })
    child.stdout.emit('end')
    child.emit('exit', 7, null)
    expect(onClose).not.toHaveBeenCalled()
    await connection.close()
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('code 7') }),
      expect.anything()
    )
    await connection.close()
  })

  it('joins close attempts and retries unproven exit without starting another process', async () => {
    vi.useFakeTimers()
    const { connection, child, spawn } = fixture({}, { exitOnEnd: false })
    const first = connection.close()
    const joined = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    expect(await first).toEqual({ root: 'live', tree: 'unverifiable' })
    expect(await joined).toEqual({ root: 'live', tree: 'unverifiable' })
    expect(teardown).toHaveBeenCalledOnce()
    teardown.mockImplementationOnce(async () => {
      child.emit('exit', null, 'SIGKILL')
      return 'unverifiable'
    })
    const retry = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    expect(await retry).toEqual({ root: 'exited', tree: 'unverifiable' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps retained descendant uncertainty when the root exits between attempts', async () => {
    vi.useFakeTimers()
    const { connection, child } = fixture({}, { exitOnEnd: false })
    const close = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    await close
    child.emit('exit', null, 'SIGKILL')
    const finishing = connection.close()
    await vi.advanceTimersByTimeAsync(1_000)
    await finishing
    expect(connection.lastCloseResult).toEqual({
      root: 'live',
      tree: 'unverifiable'
    })
    expect(connection.rootVerdict).toBe('exited')
  })

  it('requires processless close evidence after a failed spawn', async () => {
    const onExit = vi.fn()
    const { connection, child } = fixture({ onExit }, { processless: true, exitOnEnd: false })
    const pending = expect(connection.request('prompt')).rejects.toThrow('ENOENT')
    child.emit('error', new Error('ENOENT'))
    await pending
    expect(connection.rootVerdict).toBe('unverifiable')
    expect(onExit).not.toHaveBeenCalled()
    child.emit('close', null, null)
    expect(connection.rootVerdict).toBe('exited')
    await connection.close()
    expect(onExit.mock.calls[0][1].exit.processless).toBe(true)
  })

  it('handles stderr failure, and isolates failing close and exit observers', async () => {
    const { connection, child } = fixture({
      onClose: () => {
        throw new Error('close observer')
      },
      onExit: () => {
        throw new Error('exit observer')
      },
      onDiagnostic: () => {
        throw new Error('diagnostic observer')
      }
    })
    const pending = expect(connection.request('prompt')).rejects.toThrow('stderr failed')
    child.stderr.emit('error', new Error('stderr failed'))
    await pending
    expect(() => child.emit('exit', 1, null)).not.toThrow()
  })

  it('validates peer limits before spawning', () => {
    const spawn = vi.fn<PipedProcessSpawner>()
    expect(
      () =>
        new JsonlRpcAgentConnection(
          { command: 'fixture', args: [] },
          { peer: { requestTimeoutMs: 0 } },
          spawn
        )
    ).toThrow('timer duration')
    expect(spawn).not.toHaveBeenCalled()
  })
})
