import './mock-descendant-sweep'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import { HostTerminalLedger } from './host-terminal-ledger'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { TerminalSpawnGate, type TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

// Two daemons on one machine, e.g. the desktop app's and an `orca serve`'s, share one dir.
describe('one automatic-restore budget per execution host', () => {
  let dir: string
  let nextPid: number
  const exits = new Map<number, (code: number) => void>()
  const hosts: TerminalHost[] = []

  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 })
    dir = mkdtempSync(join(tmpdir(), 'orca-shared-budget-'))
    nextPid = 5000
    exits.clear()
  })

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()))
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function daemon(
    pid: number,
    mode: TerminalSpawnAdmissionMode = 'enforce'
  ): { host: TerminalHost; gate: TerminalSpawnGate } {
    const spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      const childPid = nextPid++
      const handle: SubprocessHandle = {
        pid: childPid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exits.get(childPid)?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exits.get(childPid)?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(childPid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    const gate = new TerminalSpawnGate({
      log: vi.fn(),
      mode,
      hostTerminals: new HostTerminalLedger({
        dir,
        maxTerminals: 256,
        pid,
        isProcessAlive: () => true,
        createDir: (path) => {
          mkdirSync(path, { recursive: true })
        },
        log: vi.fn()
      })
    })
    const host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
    hosts.push(host)
    return { host, gate }
  }

  function restore(
    host: TerminalHost,
    sessionId: string,
    declaredIntent: SpawnIntent | null = 'automatic-restore',
    deadlineAt = Number.POSITIVE_INFINITY
  ) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      historySeedChunks: ['seed'],
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: sessionId.padEnd(43, 'a'),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: `tab-${sessionId}`,
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: `term_${sessionId}`
        }
      },
      spawnAdmission: { clientId: 'client', declaredIntent, deadlineAt },
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('counts the other daemon live restores against one live cap of 8', async () => {
    const desktop = daemon(100)
    const serve = daemon(200)
    for (let i = 0; i < 5; i++) {
      await restore(desktop.host, `desktop-${i}`)
      await vi.advanceTimersByTimeAsync(1000)
    }
    for (let i = 0; i < 3; i++) {
      await restore(serve.host, `serve-${i}`)
      await vi.advanceTimersByTimeAsync(1000)
    }
    await expect(restore(serve.host, 'serve-ninth')).rejects.toThrow(
      'terminal_spawn_deferred:live_cap'
    )

    exits.get(5000)?.(0)
    await expect(restore(serve.host, 'serve-ninth')).resolves.toMatchObject({ isNew: true })
  })

  it('counts restores an observing desktop admitted against the serve daemon budget', async () => {
    // Why intended: the budget protects the machine, and restores the desktop already runs use it.
    const desktop = daemon(100, 'observe')
    const serve = daemon(200)
    for (let i = 0; i < 8; i++) {
      await restore(desktop.host, `desktop-${i}`)
    }
    await vi.advanceTimersByTimeAsync(5000)
    await expect(restore(serve.host, 'serve-a')).rejects.toThrow('terminal_spawn_deferred:live_cap')
    await expect(restore(serve.host, 'serve-legacy', null)).resolves.toMatchObject({ isNew: true })
  })

  it('spends one burst across both daemons', async () => {
    const desktop = daemon(100)
    const serve = daemon(200)
    await restore(desktop.host, 'desktop-a')
    await restore(desktop.host, 'desktop-b')
    await restore(serve.host, 'serve-a')
    const paced = restore(serve.host, 'serve-b', null)
    let settled = false
    void paced.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(paced).resolves.toMatchObject({ isNew: true })
  })

  it('lets a waiter through once the other daemon frees a concurrency slot', async () => {
    const desktop = daemon(100)
    const serve = daemon(200)
    const desktopGate = desktop.gate
    // Three forks admitted on the desktop that have not published a session yet.
    const leases = [0, 1, 2].map(() =>
      desktopGate.admit({
        clientId: 'client',
        declaredIntent: null,
        hasAgentSessionClaim: true,
        hasHistorySeed: true,
        deadlineAt: Number.POSITIVE_INFINITY
      })
    )
    await vi.advanceTimersByTimeAsync(5000)
    const waiting = restore(serve.host, 'serve-a', null)
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(settled).toBe(false)

    for (const lease of leases) {
      ;(await lease).abandon()
    }
    await vi.advanceTimersByTimeAsync(1000)
    await expect(waiting).resolves.toMatchObject({ isNew: true })
  })
})
