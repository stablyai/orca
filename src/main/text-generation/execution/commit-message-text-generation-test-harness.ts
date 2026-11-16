import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import { expect, vi } from 'vitest'

export type MockDiscoveryChild = ChildProcess & {
  pid: number
  kill: ReturnType<typeof vi.fn<() => boolean>>
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough & { end: ReturnType<typeof vi.fn> }
}

export function createMockDiscoveryChild(): MockDiscoveryChild {
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdout: { writable: true, configurable: true, enumerable: true },
    stderr: { writable: true, configurable: true, enumerable: true },
    stdin: { writable: true, configurable: true, enumerable: true }
  })
  return Object.assign(child, {
    pid: 123,
    kill: vi.fn(() => true),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: Object.assign(new PassThrough(), { end: vi.fn() })
  })
}

/** Answers initialize, then each `model/list` with the next page (`{ rpcError }` replies an error), as a Codex app-server child. */
export function answerCodexAppServer(
  child: { stdin: NodeJS.EventEmitter; stdout: NodeJS.EventEmitter },
  pages: unknown[]
): void {
  let page = 0
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      const message: unknown = JSON.parse(line)
      if (isProviderRecord(message) && typeof message.id === 'number') {
        const answer = message.method === 'model/list' ? pages[page++] : {}
        const error = isProviderRecord(answer) ? answer.rpcError : undefined
        const reply = Buffer.from(
          `${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result: answer })}\n`
        )
        // Real streams may be piped onward by the spawner; plain emitters only have listeners.
        if (child.stdout instanceof PassThrough) {
          child.stdout.write(reply)
        } else {
          child.stdout.emit('data', reply)
        }
      }
    }
  })
}

export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

// Bind the hoisted Windows tree-kill mock; supervised POSIX stop uses SIGTERM in source-control-local-process.test.ts.
export function createChildTerminationExpectation(
  terminateWindowsProcessTreeMock: ReturnType<typeof vi.fn>
): (child: { pid: number; kill: ReturnType<typeof vi.fn> }) => Promise<void> {
  return async (child) => {
    if (process.platform === 'win32') {
      expect(terminateWindowsProcessTreeMock).toHaveBeenCalledWith(child.pid, {
        site: 'source-control-text-generation'
      })
    }
    // Kill the owned root handle too so refused Windows tree walks cannot release the home lock having killed nothing; root kill follows the walk.
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
  }
}

/** Unwrap supervisor -- before inspecting the actual agent argv. */
export function spawnedAgentArgv([file, args]: readonly unknown[]): unknown[] {
  const argv: unknown[] = Array.isArray(args) ? args : []
  return file === process.execPath && argv[0] === '-e'
    ? argv.slice(argv.indexOf('--') + 1)
    : [file, ...argv]
}
