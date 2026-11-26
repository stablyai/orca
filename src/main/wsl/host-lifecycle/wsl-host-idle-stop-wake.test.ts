// #46567: an idle-stopped WSL host boots once for its user's calls; a poll never boots or waits.
import { describe, expect, it, vi } from 'vitest'
import { ensureWslHostForRuntimeCall, type WslHostRuntimeCallPort } from './wsl-host-runtime-call'
import {
  isWslHostIdleStopped,
  noteWslHostIdleStop,
  withWslHostIdleStop
} from './wsl-host-idle-stop'
import type { WslOrcadConnection } from '../orcad/wsl-orcad-connection-types'

const DISTRO = 'Ubuntu'
const ENVIRONMENT_ID = 'wsl:ubuntu'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake reads no field of it
const connection = {} as WslOrcadConnection

function portFor(connects: { count: number }, booted: Promise<void>) {
  return (call: Pick<WslHostRuntimeCallPort, 'wake' | 'background'>): WslHostRuntimeCallPort =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields an idle-stop wake reads
    ({
      record: { environmentId: ENVIRONMENT_ID, distro: DISTRO },
      connector: {
        reachability: async () => 'unreachable',
        connect: async () => {
          connects.count += 1
          await booted
          // The woken server's ready report is what ends the idle stop.
          withWslHostIdleStop(DISTRO, null, { state: 'ready', census: null })
          return connection
        }
      },
      deps: { hasServerFiles: () => true, userDataPath: () => '/tmp' },
      removing: new Set<string>(),
      parked: new Set<string>(),
      ...call
    }) as unknown as WslHostRuntimeCallPort
}

describe('waking a WSL host Orca stopped idle', () => {
  it('boots once for concurrent user calls, lets plain calls wait on it, refuses polls', async () => {
    noteWslHostIdleStop(ENVIRONMENT_ID)
    // Liveness saw the old orcad exit, so the wake needn't wait for it.
    withWslHostIdleStop(DISTRO, null, { state: 'idle', terminals: 'unverifiable' })
    const connects = { count: 0 }
    const boot = Promise.withResolvers<void>()
    const port = portFor(connects, boot.promise)

    const first = ensureWslHostForRuntimeCall(ENVIRONMENT_ID, port({ wake: true }))
    const second = ensureWslHostForRuntimeCall(ENVIRONMENT_ID, port({ wake: true }))
    await vi.waitFor(() => expect(connects.count).toBe(1))
    const plain = ensureWslHostForRuntimeCall(ENVIRONMENT_ID, port({}))
    await expect(
      ensureWslHostForRuntimeCall(ENVIRONMENT_ID, port({ background: true }))
    ).rejects.toThrow('stopped while idle')

    boot.resolve()
    await Promise.all([first, second, plain])
    expect(connects.count).toBe(1)
    expect(isWslHostIdleStopped(ENVIRONMENT_ID)).toBe(false)
  })

  it('never boots for a call without the user behind it', async () => {
    noteWslHostIdleStop(ENVIRONMENT_ID)
    const connects = { count: 0 }
    const port = portFor(connects, Promise.resolve())
    await expect(ensureWslHostForRuntimeCall(ENVIRONMENT_ID, port({}))).rejects.toThrow(
      'stopped while idle'
    )
    expect(connects.count).toBe(0)
    expect(isWslHostIdleStopped(ENVIRONMENT_ID)).toBe(true)
  })
})
