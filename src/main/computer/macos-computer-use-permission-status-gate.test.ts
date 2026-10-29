import { describe, expect, it, vi } from 'vitest'
import type {
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import {
  bindPermissionStatusGateToAppActivity,
  createPermissionStatusProbeGate
} from './macos-computer-use-permission-status-gate'

function statusWith(accessibility: ComputerUsePermissionStatus): ComputerUsePermissionStatusResult {
  return {
    platform: 'darwin',
    helperAppPath: '/Applications/Orca Computer Use.app',
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: accessibility },
      { id: 'screenshots', status: 'granted' }
    ]
  }
}

const denied = statusWith('not-granted')
const granted = statusWith('granted')
const background = { background: true }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('createPermissionStatusProbeGate', () => {
  it('stops relaunching the helper for passive readers while Accessibility stays denied (#34390)', async () => {
    let clock = 0
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    // Three always-mounted setup-guide hooks read on every window focus.
    await Promise.all([gate.read(background), gate.read(background), gate.read(background)])
    expect(probe).toHaveBeenCalledTimes(1)

    for (let elapsed = 0; elapsed < 600_000; elapsed += 500) {
      clock += 500
      await gate.read(background)
    }
    // Backoff 10s, 20s, 40s, 80s, then 120s cap: 8 launches in 10 minutes instead of 1,200.
    expect(probe).toHaveBeenCalledTimes(8)

    gate.noteAppReturn()
    await gate.read(background)
    expect(probe).toHaveBeenCalledTimes(8)
  })

  it('re-probes once per return to the app so a grant or revocation shows immediately', async () => {
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => 0 })

    await expect(gate.read(background)).resolves.toBe(denied)
    gate.noteAppDeparture()
    gate.noteAppReturn()
    const reads = await Promise.all([gate.read(background), gate.read(background)])
    expect(reads).toEqual([granted, granted])
    expect(probe).toHaveBeenCalledTimes(2)

    probe.mockResolvedValueOnce(denied)
    gate.noteAppDeparture()
    gate.noteAppReturn()
    await expect(gate.read(background)).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('serves a fresh read when the renderer focus read beats did-become-active', async () => {
    let active = false
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => 0 })
    gate.setAppActiveProbe(() => active)

    await gate.read(background)
    gate.noteAppDeparture()
    await expect(gate.read(background)).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(1)

    active = true
    await expect(gate.read(background)).resolves.toBe(granted)
    gate.noteAppReturn()
    await expect(gate.read(background)).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('counts the first app return after a startup spent inactive', async () => {
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => 0 })
    let returnToApp = (): void => {}
    let active = false
    bindPermissionStatusGateToAppActivity(gate, {
      onDeparture: () => {},
      onReturn: (listener) => {
        returnToApp = listener
      },
      isAppActive: () => active
    })

    await gate.read(background)
    active = true
    returnToApp()
    await expect(gate.read(background)).resolves.toBe(granted)
  })

  it('never serves a finished denial to foreground readers, even on a quick return', async () => {
    let clock = 0
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    await gate.read()
    // The user grants at 250ms and the browser returns at 500ms.
    clock += 500
    await expect(gate.read(background)).resolves.toBe(denied)
    const reads = await Promise.all([gate.read(), gate.read(), gate.read()])
    expect(reads).toEqual([granted, granted, granted])
    expect(probe).toHaveBeenCalledTimes(2)

    clock += 2_000 - 1
    await expect(gate.read()).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('discards an invalidated in-flight probe without overlapping helpers', async () => {
    let clock = 0
    const first = deferred<ComputerUsePermissionStatusResult>()
    const probe = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(denied)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    const obsolete = gate.read(background)
    gate.invalidate()
    const current = gate.read(background)
    expect(probe).toHaveBeenCalledTimes(1)

    first.resolve(denied)
    await expect(obsolete).resolves.toBe(denied)
    await expect(current).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(2)

    // Only the live probe counts toward the backoff: first step is 10s, not 20s.
    clock += 10_000
    await gate.read(background)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('shares a failed check briefly instead of backing it off like a denial', async () => {
    let clock = 0
    const failure = new Error('Timed out checking permissions')
    const probe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    const results = await Promise.allSettled([gate.read(background), gate.read(background)])
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 2_000
    await expect(gate.read(background)).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
