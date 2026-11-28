// #46567: an orcad that said it stopped idle stays down under visible work; a crash still relaunches.
import { describe, expect, it, vi } from 'vitest'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import type { WslOrcadConnection } from './wsl-orcad-connection-types'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'

const DISTRO = 'Ubuntu'
// Settle, stopping-list and first-backoff waits fire at once; heartbeats and slow re-verifies never.
const FIRES_BELOW_MS = 30_000

function connection(pid: number): WslOrcadConnection {
  return {
    distro: DISTRO,
    environmentId: 'wsl:ubuntu',
    localPort: 4000,
    remotePort: 5000,
    fullVersion: '1.0.0',
    pid,
    linuxUser: null,
    defaultLinuxUser: null,
    pairingOffer: '',
    deferredUpdate: null,
    close: async () => {}
  }
}

async function exitOrcad(idleStopped: boolean) {
  let clock = 0
  let pid = 1
  let exitWatch: (code: number | null) => void = () => {}
  const published: WslOrcadConnectionStatus['state'][] = []
  const launches: number[] = []
  let retired = false
  const supervisor = new WslOrcadLivenessSupervisor({
    manager: {
      ensure: async () => {
        launches.push(pid)
        return connection(pid)
      },
      get: () => (retired ? null : connection(pid)),
      publish: (_distro, status) => published.push(status.state),
      close: async () => {},
      retireListener: async () => {
        retired = true
      }
    },
    readRunning: async () => ({ status: 'confirmed', distros: [DISTRO] }),
    // Same distro boot; orcad's pid changes once it exits.
    readIdentity: async () => ({ distroInstance: 'boot-1', orcad: `orcad-${pid}` }),
    openWatch: async () => ({
      signal: 'ready',
      onExit: (listener) => {
        exitWatch = listener
      },
      close: () => {},
      proving: () => true
    }),
    collectCensus: async () => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
    wasIdleStopped: () => idleStopped,
    hasUserVisibleWork: () => true,
    deferUntilRunning: () => {},
    monotonicNow: () => clock,
    schedule: (delayMs, task) => {
      let cancelled = false
      if (delayMs < FIRES_BELOW_MS) {
        queueMicrotask(() => {
          if (!cancelled) {
            clock += delayMs
            task()
          }
        })
      }
      return { cancel: () => (cancelled = true) }
    },
    random: () => 0
  })
  await supervisor.connect(DISTRO)
  launches.length = 0
  pid = 2
  exitWatch(0)
  await vi.waitFor(() => expect(published.some((state) => state !== 'reconnecting')).toBe(true))
  await supervisor.dispose()
  return { published, launches }
}

describe('WSL liveness after orcad exits with its workspace still open', () => {
  it('leaves an idle-stopped orcad down', async () => {
    const { published, launches } = await exitOrcad(true)
    expect(new Set(published)).toEqual(new Set(['idle']))
    expect(launches).toEqual([])
  })

  it('relaunches one that crashed', async () => {
    const { published, launches } = await exitOrcad(false)
    expect(published).toEqual(['reconnecting', 'ready'])
    expect(launches).toEqual([2])
  })
})
