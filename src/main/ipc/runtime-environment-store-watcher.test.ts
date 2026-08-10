import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from '../../shared/runtime-environment-store'
import {
  registerRuntimeEnvironmentStoreWatcher,
  RUNTIME_ENVIRONMENTS_CHANGED_CHANNEL
} from './runtime-environment-store-watcher'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

type Harness = {
  userDataPath: string
  send: ReturnType<typeof vi.fn>
  invalidateTransport: ReturnType<typeof vi.fn>
  waitForBroadcasts: (count: number) => Promise<void>
  settle: () => Promise<void>
}

const cleanups: (() => void)[] = []

function startWatcher(): Harness {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-watch-'))
  const send = vi.fn()
  const invalidateTransport = vi.fn()
  const unregister = registerRuntimeEnvironmentStoreWatcher({
    userDataPath,
    getWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
    invalidateTransport,
    debounceMs: 20
  })
  cleanups.push(() => {
    unregister()
    rmSync(userDataPath, { recursive: true, force: true })
  })
  return {
    userDataPath,
    send,
    invalidateTransport,
    waitForBroadcasts: (count) =>
      vi.waitFor(() => {
        expect(send.mock.calls.length).toBeGreaterThanOrEqual(count)
      }),
    // Why: "no broadcast" needs the debounce window plus fs.watch delivery to elapse.
    settle: () => new Promise((resolve) => setTimeout(resolve, 250))
  }
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

describe('registerRuntimeEnvironmentStoreWatcher', () => {
  it('broadcasts when an environment is added externally', async () => {
    const harness = startWatcher()
    addEnvironmentFromPairingCode(harness.userDataPath, {
      name: 'sandbox',
      pairingCode: pairingCode()
    })
    await harness.waitForBroadcasts(1)
    expect(harness.send).toHaveBeenCalledWith(RUNTIME_ENVIRONMENTS_CHANGED_CHANNEL)
    expect(harness.invalidateTransport).not.toHaveBeenCalled()
  })

  it('stays silent for lastUsedAt-only rewrites', async () => {
    const harness = startWatcher()
    addEnvironmentFromPairingCode(harness.userDataPath, {
      name: 'sandbox',
      pairingCode: pairingCode(),
      now: 100
    })
    await harness.waitForBroadcasts(1)
    harness.send.mockClear()
    markEnvironmentUsed(harness.userDataPath, 'sandbox', { now: 200_000 })
    await harness.settle()
    expect(harness.send).not.toHaveBeenCalled()
  })

  it('broadcasts and retires the transport when an environment is removed externally', async () => {
    const harness = startWatcher()
    const added = addEnvironmentFromPairingCode(harness.userDataPath, {
      name: 'sandbox',
      pairingCode: pairingCode()
    })
    await harness.waitForBroadcasts(1)
    harness.send.mockClear()
    removeEnvironment(harness.userDataPath, added.id)
    await harness.waitForBroadcasts(1)
    expect(harness.invalidateTransport).toHaveBeenCalledWith(added.id)
  })

  it('retires the transport when an environment is re-paired externally', async () => {
    const harness = startWatcher()
    const added = addEnvironmentFromPairingCode(harness.userDataPath, {
      name: 'sandbox',
      pairingCode: pairingCode(),
      now: 100
    })
    await harness.waitForBroadcasts(1)
    harness.send.mockClear()
    updateEnvironmentFromPairingCode(harness.userDataPath, added.id, {
      pairingCode: pairingCode('ws://127.0.0.1:7777'),
      now: 5_000
    })
    await harness.waitForBroadcasts(1)
    expect(harness.invalidateTransport).toHaveBeenCalledWith(added.id)
  })
})
