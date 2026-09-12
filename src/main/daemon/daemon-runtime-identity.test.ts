import { describe, expect, it } from 'vitest'
import type { BunRuntime } from './pty-subprocess/bun-pty-process-contract'
import { readDaemonRuntimeIdentity } from './daemon-runtime-identity'

const bunRuntime: BunRuntime = {
  Terminal: {},
  spawn: () => {
    throw new Error('not used')
  }
}

describe('readDaemonRuntimeIdentity', () => {
  it('reports Bun and the Bun terminal backend from the daemon process', () => {
    expect(
      readDaemonRuntimeIdentity(bunRuntime, {
        node: '22.0.0',
        bun: '1.4.0'
      } as typeof process.versions & { bun: string })
    ).toEqual({ runtimeKind: 'bun', runtimeVersion: '1.4.0', ptyBackend: 'bun-terminal' })
  })

  it('reports Node when Bun is absent even if a Terminal-shaped global is unavailable', () => {
    expect(
      readDaemonRuntimeIdentity(undefined, {
        node: '22.0.0'
      } as typeof process.versions)
    ).toEqual({ runtimeKind: 'node', ptyBackend: 'node-pty' })
  })

  it('does not claim Bun PTYs when Bun lacks the Terminal API', () => {
    const runtime = { ...bunRuntime, Terminal: undefined }
    expect(
      readDaemonRuntimeIdentity(runtime, {
        node: '22.0.0',
        bun: '1.4.0'
      } as typeof process.versions & { bun: string })
    ).toEqual({ runtimeKind: 'bun', runtimeVersion: '1.4.0', ptyBackend: 'node-pty' })
  })
})
