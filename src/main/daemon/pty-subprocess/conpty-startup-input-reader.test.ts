import type * as pty from 'node-pty'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyPhysicalOwner } from './subprocess-handle'
import type { spawnConptyWithInputReader as SpawnWithReader } from './conpty-startup-input-reader'

const NOTICE_MARKER = 'Windows could not start keyboard input'

type FakePane = { proc: pty.IPty; physicalOwner: DaemonPtyPhysicalOwner; forceKill: () => void }

// A pane that emits `output` once the reader subscribes, the way node-pty relays ConPTY's first chunk.
function fakePane(useConptyDll: boolean, output: string): FakePane {
  const forceKill = vi.fn()
  const disposable = { dispose: () => {} }
  const proc = {
    _agent: { _useConpty: true, _useConptyDll: useConptyDll },
    onData: (listener: (data: string) => void) => {
      setImmediate(() => listener(output))
      return disposable
    },
    write: vi.fn()
  }
  const physicalOwner = {
    onExit: () => disposable,
    forceKill,
    completion: Promise.resolve()
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader touches only onData, write and _agent.
    proc: proc as unknown as pty.IPty,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader touches only onExit, forceKill and completion.
    physicalOwner: physicalOwner as unknown as DaemonPtyPhysicalOwner,
    forceKill
  }
}

let spawnConptyWithInputReader: typeof SpawnWithReader

describe('spawnConptyWithInputReader with the system ConPTY fallback (#47506)', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Fresh module: announcementObserved is process-wide state.
    vi.resetModules()
    ;({ spawnConptyWithInputReader } = await import('./conpty-startup-input-reader'))
    // A bundled pane announces first, arming the check the way a long-lived daemon would.
    const bundled = fakePane(true, '\x1b[c')
    await spawnConptyWithInputReader(async () => bundled, { label: 'cmd.exe', respawnSafe: true })
  })

  it('keeps a system-ConPTY pane that never sends the bundled announcement', async () => {
    const system = fakePane(false, 'PS C:\\> ')
    const spawn = vi.fn(async () => system)
    const result = await spawnConptyWithInputReader(spawn, { label: 'pwsh.exe', respawnSafe: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(system.forceKill).not.toHaveBeenCalled()
    expect(result.proc).toBe(system.proc)
    expect(result.claimStartupEvents().data.join('')).not.toContain(NOTICE_MARKER)
  })

  it('keeps a respawn that landed on the system ConPTY', async () => {
    const bundledMiss = fakePane(true, 'garbage')
    const system = fakePane(false, 'PS C:\\> ')
    const spawn = vi.fn().mockResolvedValueOnce(bundledMiss).mockResolvedValueOnce(system)
    const result = await spawnConptyWithInputReader(spawn, { label: 'pwsh.exe', respawnSafe: true })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(bundledMiss.forceKill).toHaveBeenCalledTimes(1)
    expect(result.proc).toBe(system.proc)
    expect(result.claimStartupEvents().data.join('')).not.toContain(NOTICE_MARKER)
  })

  it('still respawns a bundled pane without an input reader', async () => {
    const bundledMiss = fakePane(true, 'garbage')
    const bundledRetry = fakePane(true, '\x1b[c')
    const spawn = vi.fn().mockResolvedValueOnce(bundledMiss).mockResolvedValueOnce(bundledRetry)
    const result = await spawnConptyWithInputReader(spawn, { label: 'pwsh.exe', respawnSafe: true })
    expect(bundledMiss.forceKill).toHaveBeenCalledTimes(1)
    expect(result.proc).toBe(bundledRetry.proc)
  })
})
