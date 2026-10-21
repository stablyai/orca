import './mock-descendant-sweep'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'
import { DaemonProcessGrowthMonitor } from './daemon-process-growth-monitor'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import {
  resolveTerminalSpawnAdmissionMode,
  TERMINAL_SPAWN_ADMISSION_ENV_VAR
} from './terminal-spawn-gate'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

// The desktop app's daemon after a restart: its renderer declares the visible pane
// `user-resume` and every hidden agent pane `automatic-restore`, with no session claim.
describe('desktop restore admission', () => {
  let dir: string
  let host: TerminalHost
  let guard: DaemonAutomaticWorkGuard
  let spawned: string[]
  let exits: Map<number, (code: number) => void>
  let nextPid: number

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    dir = mkdtempSync(join(tmpdir(), 'orca-desktop-restore-'))
    spawned = []
    exits = new Map()
    nextPid = 2000
  })

  afterEach(async () => {
    await host?.dispose()
    guard?.stop()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function startDesktopDaemon(): void {
    const markerPath = join(dir, 'daemon-v1.automatic-work-run.json')
    guard = new DaemonAutomaticWorkGuard({
      markerPath,
      // What the desktop launcher passes with no rollback switch set.
      mode: resolveTerminalSpawnAdmissionMode({}),
      log: { log: vi.fn() },
      listSessions: () => [],
      ownsEndpoint: () => true,
      monitor: new DaemonProcessGrowthMonitor({
        listSessions: () => [],
        recentAutomaticWork: () => false,
        sampleWhenIdle: false,
        onLevelChanged: () => {},
        onTrip: () => {},
        readRows: async () => []
      })
    })
    guard.start()
    const spawnSubprocess = vi.fn<SpawnSubprocess>((opts) => {
      const pid = nextPid++
      spawned.push(opts.sessionId)
      const handle: SubprocessHandle = {
        pid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exits.get(pid)?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exits.get(pid)?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(pid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    host = new TerminalHost({ spawnSubprocess, spawnGate: guard.gate })
  }

  function restore(sessionId: string, declaredIntent: SpawnIntent) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      historySeedChunks: ['seed'],
      spawnAdmission: {
        clientId: 'desktop-main',
        declaredIntent,
        // The daemon's cap for a desktop create (30 s request timeout, halved, capped at 12 s).
        deadlineAt: Date.now() + 12_000
      },
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  function shell(sessionId: string) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('enforces on desktop unless the rollback switch asks to observe', () => {
    expect(resolveTerminalSpawnAdmissionMode({})).toBe('enforce')
    expect(
      resolveTerminalSpawnAdmissionMode({ [TERMINAL_SPAWN_ADMISSION_ENV_VAR]: 'enforce' })
    ).toBe('enforce')
    expect(resolveTerminalSpawnAdmissionMode({ [TERMINAL_SPAWN_ADMISSION_ENV_VAR]: 'bogus' })).toBe(
      'enforce'
    )
    expect(
      resolveTerminalSpawnAdmissionMode({ [TERMINAL_SPAWN_ADMISSION_ENV_VAR]: ' Observe ' })
    ).toBe('observe')
  })

  it('restores the visible pane at once, at most 8 hidden agents, and keeps the rest sleeping', async () => {
    startDesktopDaemon()
    const hidden = Array.from({ length: 19 }, (_, i) =>
      restore(`hidden-${i}`, 'automatic-restore').then(
        () => 'restored' as const,
        (error: Error) => error.message
      )
    )
    // Why sent last: the visible pane must not queue behind a storm already in progress.
    const visible = restore('visible', 'user-resume')
    await vi.advanceTimersByTimeAsync(0)
    await expect(visible).resolves.toMatchObject({ isNew: true })
    expect(spawned).toContain('visible')
    // Never more than the burst of 3 automatic forks before the first second passes.
    expect(spawned.filter((id) => id.startsWith('hidden-'))).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(12_000)
    const outcomes = await Promise.all(hidden)
    expect(outcomes.filter((outcome) => outcome === 'restored')).toHaveLength(8)
    expect(outcomes.filter((outcome) => outcome !== 'restored')).toEqual(
      Array.from({ length: 11 }, () => 'terminal_spawn_deferred:live_cap')
    )
    expect(spawned).toHaveLength(9)
    expect(guard.gate.snapshot()).toMatchObject({ mode: 'enforce', liveAutomatic: 8, waiting: 0 })
  })

  it('resumes a sleeping pane as soon as the user opens it, even at the live cap', async () => {
    startDesktopDaemon()
    const hidden = Array.from({ length: 9 }, (_, i) =>
      restore(`hidden-${i}`, 'automatic-restore').catch((error: Error) => error.message)
    )
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await hidden[8]).toBe('terminal_spawn_deferred:live_cap')
    expect(guard.gate.snapshot().liveAutomatic).toBe(8)

    // Opening the sleeping pane retries it as the user's own resume; no timer runs before it forks.
    await expect(restore('hidden-8', 'user-resume')).resolves.toMatchObject({ isNew: true })
    expect(spawned.at(-1)).toBe('hidden-8')
  })

  it('never delays a manual new terminal behind a restore storm', async () => {
    startDesktopDaemon()
    const storm = Array.from({ length: 12 }, (_, i) =>
      restore(`hidden-${i}`, 'automatic-restore').catch(() => null)
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(guard.gate.snapshot().waiting).toBeGreaterThan(0)

    await expect(shell('manual')).resolves.toMatchObject({ isNew: true })
    expect(spawned).toContain('manual')
    await vi.advanceTimersByTimeAsync(12_000)
    await Promise.all(storm)
  })

  // Windows cannot tell a new boot from the same one (Fast Startup), so it never pauses.
  it.skipIf(process.platform === 'win32')(
    'keeps hidden agents sleeping after a same-boot crash, but restores the visible pane',
    async () => {
      writeFileSync(
        join(dir, 'daemon-v1.automatic-work-run.json'),
        JSON.stringify({
          schemaVersion: 1,
          boot: { bootTimeMs: Date.now() - uptime() * 1000, bootId: null },
          state: 'running',
          mode: { kind: 'normal' }
        })
      )
      startDesktopDaemon()
      expect(guard.status()).toMatchObject({
        admission: 'enforce',
        mode: { kind: 'paused', reason: 'unclean_host_death' }
      })

      await expect(restore('hidden', 'automatic-restore')).rejects.toThrow(
        'terminal_spawn_deferred:paused'
      )
      await expect(restore('visible', 'user-resume')).resolves.toMatchObject({ isNew: true })
      await expect(shell('manual')).resolves.toMatchObject({ isNew: true })

      // A visible split of six agents spends the user allowance of 4; the rest are paced, not slept.
      const split = Array.from({ length: 5 }, (_, i) => restore(`split-${i}`, 'user-resume'))
      await vi.advanceTimersByTimeAsync(12_000)
      await expect(Promise.all(split)).resolves.toHaveLength(5)

      guard.resume()
      await expect(restore('hidden', 'automatic-restore')).resolves.toMatchObject({ isNew: true })
      expect(spawned.at(-1)).toBe('hidden')
      expect(spawned).toHaveLength(8)
    }
  )
})
