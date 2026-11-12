import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import type {
  SourceControlAgentSpawnInput,
  SpawnedSourceControlAgentProcess
} from '../../../text-generation/source-control-text-generation-types'
import { runOpenCodeWslTextTask } from './opencode-wsl-text-task'

const guestRequest = z.looseObject({ nonce: z.string() })
type GuestRequest = z.infer<typeof guestRequest>

/** A guest launcher that answers its request frame with `respond`, after login-shell chatter. */
function fakeGuest(respond: (request: GuestRequest, canceled: Promise<void>) => Promise<unknown>) {
  const launched: SourceControlAgentSpawnInput[] = []
  const requests: GuestRequest[] = []
  let child!: SpawnedSourceControlAgentProcess
  const spawnAgent = vi.fn((input: SourceControlAgentSpawnInput) => {
    launched.push(input)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const launcher = new ChildProcess()
    Object.defineProperties(launcher, {
      stdout: { writable: true, configurable: true, enumerable: true },
      stderr: { writable: true, configurable: true, enumerable: true },
      stdin: { writable: true, configurable: true, enumerable: true }
    })
    Object.assign(launcher, { pid: 99, stdin, stdout, stderr: new PassThrough() })
    child = launcher
    const canceled = new Promise<void>((resolve) => stdin.on('finish', () => resolve()))
    stdout.write('Welcome to Ubuntu\n')
    stdin.once('data', (chunk: Buffer) => {
      const request = guestRequest.parse(JSON.parse(chunk.toString('utf8')))
      requests.push(request)
      void respond(request, canceled).then((result) => {
        stdout.write(`${request.nonce}${JSON.stringify(result)}\n`)
        setTimeout(() => {
          Object.assign(launcher, { exitCode: 0 })
          launcher.emit('close', 0)
        }, 10)
      })
    })
    return launcher
  })
  return { launched, requests, spawnAgent, child: () => child }
}

const prepare = vi.fn(async () => ({
  node: '/home/dev/.cache/orca/node-runtime/bin/node',
  helper: '/mnt/c/Program Files/Orca/resources/relay/wsl/opencode-text-task-wsl.cjs'
}))

function task(signal = new AbortController().signal) {
  return {
    distro: 'Ubuntu',
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    commandEnv: { OPENCODE_CONFIG: '/home/dev/work.json' },
    binary: 'opencode',
    prefixArgs: ['--print-logs'],
    prompt: 'Write a commit message',
    runArgs: ['--model', 'anthropic/claude-sonnet', '--file', 'C:\\notes\\context.txt'],
    signal,
    timeoutMs: 60_000
  }
}

describe('runOpenCodeWslTextTask', () => {
  it('cancels by ending the guest stdin and settles only after the guest exits', async () => {
    const controller = new AbortController()
    const guest = fakeGuest(async (_request, canceled) => {
      setImmediate(() => controller.abort(new Error('canceled by user')))
      await canceled
      return { ok: false, stage: 'aborted' }
    })

    await expect(
      runOpenCodeWslTextTask(task(controller.signal), { prepare, spawnAgent: guest.spawnAgent })
    ).rejects.toThrow('canceled by user')

    expect(guest.child().exitCode).toBe(0)
  })
})
