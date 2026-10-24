import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
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

export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

// Binds the caller's hoisted tree-kill mock so test bodies keep calling
// expectChildTerminated(child) with no extra argument. Asserts the Windows direct-child kill; a
// supervised POSIX child is stopped with SIGTERM instead (source-control-local-process.test.ts).
export function createChildTerminationExpectation(
  terminateWindowsProcessTreeMock: ReturnType<typeof vi.fn>
): (child: { pid: number; kill: ReturnType<typeof vi.fn> }) => Promise<void> {
  return async (child) => {
    if (process.platform === 'win32') {
      expect(terminateWindowsProcessTreeMock).toHaveBeenCalledWith(child.pid, {
        site: 'source-control-text-generation'
      })
    }
    // Every platform kills the root by its own handle. On win32 that is not a
    // duplicate of the tree walk: it is what keeps a refused walk from resolving
    // having killed nothing while the caller releases the managed-home lock. It
    // runs after the walk there, so it can be a tick behind the caller.
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
  }
}

/** The argv a spawn started as the agent: past the supervisor script's '--' when supervised. */
export function spawnedAgentArgv([file, args]: readonly unknown[]): unknown[] {
  const argv: unknown[] = Array.isArray(args) ? args : []
  return file === process.execPath && argv[0] === '-e'
    ? argv.slice(argv.indexOf('--') + 1)
    : [file, ...argv]
}
