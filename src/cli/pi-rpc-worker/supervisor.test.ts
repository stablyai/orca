import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HANDSHAKE_STATUS_KEY,
  PI_RPC_WORKER_ACTIVE_TOOL_NAMES,
  type WorkspaceRuntimeDescriptor
} from './extension-source'
import { supervisePiRpcWorker } from './supervisor'
import type { PiRpcWorkerDispatchEnvelope, RpcObject, RuntimeClientLike } from './types'

const workspaceRuntime: WorkspaceRuntimeDescriptor = {
  sourceHash: 'b'.repeat(64),
  securitySource: 'file:///trusted/workspace-security.ts',
  mutationSource: 'file:///trusted/workspace-mutation.ts'
}

const envelope: PiRpcWorkerDispatchEnvelope = {
  protocol: 'orca.pi.rpc-worker.dispatch',
  version: 1,
  taskId: 'task_private',
  dispatchId: 'ctx_private',
  workerHandle: 'term_private',
  capability: 'dcap_private',
  taskSpec: 'Implement the bounded parser without printing task_private.',
  cliCommand: 'orca'
}

const originalEnvironment = {
  ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
  PIGUARD_BYPASS: process.env.PIGUARD_BYPASS
}

afterEach(() => {
  restoreEnvironment('ORCA_TERMINAL_HANDLE', originalEnvironment.ORCA_TERMINAL_HANDLE)
  restoreEnvironment('PIGUARD_BYPASS', originalEnvironment.PIGUARD_BYPASS)
})

describe('Pi RPC supervisor acceptance', () => {
  it('keeps authority parent-side and accepts only an exact clean lifecycle settlement', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_environment_private'
    process.env.PIGUARD_BYPASS = '1'
    let nonce = ''
    let prompt: RpcObject | undefined
    let childEnvironment: NodeJS.ProcessEnv | undefined
    const client = acceptingRuntimeClient()
    const child = createScriptedChild((command, output, close) => {
      if (command.type !== 'prompt') {
        return
      }
      prompt = command
      const done = {
        outcome: 'succeeded',
        subject: 'Implemented parser',
        body: 'Implemented the parser. Focused tests pass. Nothing remains.',
        filesModified: ['src/parser.ts']
      }
      emit(output, {
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: true
      })
      emit(output, { type: 'agent_start' })
      emit(output, {
        type: 'tool_execution_start',
        toolCallId: 'done-1',
        toolName: 'orca_worker_done',
        args: done
      })
      emit(output, {
        type: 'tool_execution_end',
        toolCallId: 'done-1',
        toolName: 'orca_worker_done',
        isError: false,
        result: {
          details: {
            protocol: 'orca.pi.lifecycle',
            version: 1,
            kind: 'worker_done',
            payload: done
          }
        }
      })
      emit(output, { type: 'agent_settled' })
      queueMicrotask(() => close(0, null))
    })
    const spawnPi = vi.fn(
      (
        _command: string,
        _argv: readonly string[],
        options: SpawnOptionsWithoutStdio
      ): ChildProcessWithoutNullStreams => {
        childEnvironment = options.env
        queueMicrotask(() => {
          emit(child.stdout, {
            type: 'extension_ui_request',
            id: 'handshake-1',
            method: 'setStatus',
            statusKey: HANDSHAKE_STATUS_KEY,
            statusText: JSON.stringify({
              protocol: 'orca.pi.rpc-worker.handshake',
              version: 1,
              nonce,
              source: 'file:///trusted/lifecycle.ts',
              workspaceRuntime: {
                sha256: workspaceRuntime.sourceHash,
                sources: [workspaceRuntime.securitySource, workspaceRuntime.mutationSource]
              },
              tools: PI_RPC_WORKER_ACTIVE_TOOL_NAMES.map((name) => ({
                name,
                source: 'file:///trusted/lifecycle.ts'
              }))
            })
          })
        })
        return child.process
      }
    )

    await supervisePiRpcWorker(
      envelope,
      {},
      {
        createRuntimeClient: async () => client,
        cleanupExtension: async () => undefined,
        resolvePi: () => '/trusted/pi',
        buildPiInvocation: () => ({
          executable: '/trusted/node',
          argsPrefix: ['/trusted/pi'],
          env: {}
        }),
        materializeExtension: async (value) => {
          nonce = value
          return {
            path: '/trusted/lifecycle.ts',
            selectedSource: 'file:///trusted/lifecycle.ts',
            source: 'fixture source',
            sourceHash: 'a'.repeat(64),
            workspaceRuntime
          }
        },
        spawnPi: spawnPi as never
      }
    )

    expect(spawnPi).toHaveBeenCalledOnce()
    expect(spawnPi.mock.calls[0]?.[0]).toBe('/trusted/node')
    expect(spawnPi.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['/trusted/pi', '/trusted/lifecycle.ts'])
    )
    expect(childEnvironment).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
    expect(childEnvironment).not.toHaveProperty('PIGUARD_BYPASS')
    expect(JSON.stringify(prompt)).toContain('Implement the bounded parser')
    expect(JSON.stringify(prompt)).toContain('[redacted]')
    for (const secret of [
      envelope.taskId,
      envelope.dispatchId,
      envelope.workerHandle,
      envelope.capability
    ]) {
      expect(JSON.stringify(prompt)).not.toContain(secret)
      expect(JSON.stringify(childEnvironment)).not.toContain(secret)
    }
    const doneCall = client.call.mock.calls.find(([method]) => method === 'orchestration.send')
    expect(doneCall?.[2]).toMatchObject({ orchestrationCapability: envelope.capability })
    expect(doneCall?.[1]).not.toHaveProperty('capability')
  })

  it('reports pre-spawn resolver failure without materializing or falling back', async () => {
    const client = acceptingRuntimeClient()
    const materializeExtension = vi.fn()
    const spawnPi = vi.fn()

    await expect(
      supervisePiRpcWorker(
        envelope,
        {},
        {
          createRuntimeClient: async () => client,
          resolvePi: () => {
            throw new Error('pi_rpc_worker_pi_executable_not_found')
          },
          materializeExtension,
          spawnPi: spawnPi as never
        }
      )
    ).rejects.toThrow('pi_rpc_worker_pi_executable_not_found')
    expect(materializeExtension).not.toHaveBeenCalled()
    expect(spawnPi).not.toHaveBeenCalled()
    const escalation = client.call.mock.calls.find(
      ([method, params]) => method === 'orchestration.send' && params.type === 'escalation'
    )
    expect(escalation?.[2]).toMatchObject({ orchestrationCapability: envelope.capability })
  })

  it('fails closed on a substituted lifecycle handshake without a fallback spawn', async () => {
    const client = acceptingRuntimeClient()
    const child = createScriptedChild(() => undefined)
    const spawnPi = vi.fn(() => {
      queueMicrotask(() => {
        emit(child.stdout, {
          type: 'extension_ui_request',
          id: 'handshake-1',
          method: 'setStatus',
          statusKey: HANDSHAKE_STATUS_KEY,
          statusText: '{"protocol":"substituted"}'
        })
      })
      return child.process
    })

    await expect(
      supervisePiRpcWorker(
        envelope,
        {},
        {
          createRuntimeClient: async () => client,
          cleanupExtension: async () => undefined,
          resolvePi: () => '/trusted/pi',
          buildPiInvocation: () => ({
            executable: '/trusted/node',
            argsPrefix: ['/trusted/pi'],
            env: {}
          }),
          materializeExtension: async () => ({
            path: '/trusted/lifecycle.ts',
            selectedSource: 'file:///trusted/lifecycle.ts',
            source: 'fixture source',
            sourceHash: 'a'.repeat(64),
            workspaceRuntime
          }),
          spawnPi: spawnPi as never
        }
      )
    ).rejects.toThrow('handshake')
    expect(spawnPi).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
  })
})

function acceptingRuntimeClient() {
  return {
    call: vi.fn(async (method: string) =>
      method === 'orchestration.send'
        ? { result: { lifecycle: { action: 'settled', outcome: 'succeeded' } } }
        : { result: {} }
    )
  } as unknown as RuntimeClientLike & { call: ReturnType<typeof vi.fn> }
}

function createScriptedChild(
  onCommand: (
    command: RpcObject,
    output: PassThrough,
    close: (code: number | null, signal: NodeJS.Signals | null) => void
  ) => void
) {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffered = ''
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    events.emit('close', code, signal)
  }
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line) {
          onCommand(JSON.parse(line) as RpcObject, stdout, close)
        }
      }
      callback()
    }
  })
  const kill = vi.fn(() => {
    queueMicrotask(() => close(null, 'SIGTERM'))
    return true
  })
  return {
    stdout,
    kill,
    process: Object.assign(events, {
      stdin,
      stdout,
      stderr,
      kill
    }) as unknown as ChildProcessWithoutNullStreams
  }
}

function emit(output: PassThrough, value: RpcObject): void {
  output.write(`${JSON.stringify(value)}\n`)
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
