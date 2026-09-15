import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData() {},
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
}

// #17696: only the daemon process can say whether TCC lets it read the cwd, so its verdict
// rides on the create result. A non-permission failure must never read as denial.
describe('TerminalHost cwd readability verdict', () => {
  let host: TerminalHost
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const spawnSubprocess: TerminalHostOptions['spawnSubprocess'] = () => createMockSubprocess()
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  const create = (sessionId: string, cwd?: string) =>
    host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      ...(cwd ? { cwd } : {}),
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

  it('reports a readable cwd as readable', async () => {
    expect((await create('readable', process.cwd())).cwdReadableByDaemon).toBe(true)
  })

  it('reports a missing cwd as readable — absence is not a permission denial', async () => {
    expect((await create('missing', '/definitely/not/a/real/dir')).cwdReadableByDaemon).toBe(true)
  })

  it('omits the verdict when no cwd was requested', async () => {
    expect((await create('no-cwd')).cwdReadableByDaemon).toBeUndefined()
  })

  it('omits the verdict on attach to an existing session', async () => {
    await create('attach', process.cwd())
    const attached = await create('attach', process.cwd())
    expect(attached.isNew).toBe(false)
    expect(attached.cwdReadableByDaemon).toBeUndefined()
  })
})
