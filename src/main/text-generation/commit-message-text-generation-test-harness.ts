import type { ChildProcess } from 'node:child_process'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type { PassThrough } from 'node:stream'
import { expect, vi } from 'vitest'

export type MockDiscoveryChild = ChildProcess & {
  pid: number
  kill: ReturnType<typeof vi.fn<() => boolean>>
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough & { end: ReturnType<typeof vi.fn> }
}

export function createMockDiscoveryChild(): MockDiscoveryChild {
  const child = createFakePipedChild(123)
  return Object.assign(child, {
    stdin: Object.assign(child.stdin, { end: vi.fn() })
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
