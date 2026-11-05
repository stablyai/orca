import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'

import { TerminalHost } from './terminal-host'

vi.mock('../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

type MockSubprocess = SubprocessHandle & {
  emitData: (data: string) => void
  emitExit: (code: number) => void
}

function mockSubprocess(
  options: { confirmShellForeground?: () => Promise<boolean> } = {}
): MockSubprocess {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    ...(options.confirmShellForeground
      ? { confirmShellForeground: options.confirmShellForeground }
      : {}),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 1)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    emitData(data) {
      onDataCb?.(data)
    },
    emitExit(code) {
      onExitCb?.(code)
    }
  } as MockSubprocess
}

const streamClient = { onData: vi.fn(), onExit: vi.fn() }

function createOptions(sessionId: string) {
  return { sessionId, cols: 80, rows: 24, streamClient }
}

describe('concurrent createOrAttach across the async spawn', () => {
  it('lets a canceled caller stop waiting on a create stuck on a dead share', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        return mockSubprocess()
      }
    })

    const stuck = host.createOrAttach(createOptions('dead-share-session'))
    const abort = new AbortController()
    const queued = host.createOrAttach({
      ...createOptions('dead-share-session'),
      cancelSignal: abort.signal
    })
    abort.abort()

    // Cancellation must release the queued caller even while the earlier spawn remains blocked.
    await expect(queued).rejects.toThrow('Attach canceled')

    releaseSpawn()
    await stuck
    await host.dispose()
  })
})
