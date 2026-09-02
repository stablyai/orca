import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

type CreateHost = (
  next: { pairing: unknown; authorityRuntimeId: string },
  callbacks: Record<string, unknown>
) => unknown

const createHostCallbacks: CreateHost[] = []
const hostOptions: { browserHostClientId: string }[] = []

vi.mock('./paired-runtime-browser-client-host', () => ({
  PairedRuntimeBrowserClientHost: class {
    constructor(options: { browserHostClientId: string }) {
      hostOptions.push(options)
    }
  }
}))

vi.mock('./browser-client-file-channel-transport', () => ({
  BrowserClientFileChannelTransport: class {
    bind(): void {}
  }
}))

vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    constructor(options: { createHost: CreateHost }) {
      createHostCallbacks.push(options.createHost)
    }

    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    close(): Promise<boolean> {
      return Promise.resolve(true)
    }

    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

function pairedEnvironment(id: string): KnownRuntimeEnvironment {
  return {
    id,
    name: `Environment ${id}`,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: 'token-a',
        publicKeyB64: 'key-a'
      }
    ]
  } as KnownRuntimeEnvironment
}

/** Boots the modules as a freshly launched process would, resolving the profile's hosting id. */
async function launch(profileDirectory: string): Promise<void> {
  vi.resetModules()
  createHostCallbacks.length = 0
  hostOptions.length = 0
  const { initializeBrowserClientHostId } = await import('./browser-client-host-id')
  initializeBrowserClientHostId(profileDirectory)
}

/** Reports the identity a client host of the current launch attaches under. */
async function hostingIdentity(): Promise<string> {
  const runtime = await import('./paired-runtime-browser-client-host-runtime')
  runtime.configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
  await runtime.startPairedRuntimeBrowserClientHost({
    environment: pairedEnvironment('environment-a'),
    authorityRuntimeId: 'runtime-a'
  })
  const createHost = createHostCallbacks[0]
  if (!createHost) {
    throw new Error('client host composition never asked for a host')
  }
  createHost({ pairing: {}, authorityRuntimeId: 'runtime-a' }, {})
  const options = hostOptions[0]
  if (!options) {
    throw new Error('client host was never constructed')
  }
  return options.browserHostClientId
}

async function hostingIdentityForLaunch(profileDirectory: string): Promise<string> {
  await launch(profileDirectory)
  return await hostingIdentity()
}

afterEach(() => {
  vi.resetModules()
})

describe('client host hosting identity wiring', () => {
  it('attaches under the same identity after the desktop relaunches', async () => {
    const profileDirectory = mkdtempSync(join(tmpdir(), 'orca-host-wiring-'))

    // Why: a per-process id made the server treat every relaunch as a new host and drop its tabs.
    expect(await hostingIdentityForLaunch(profileDirectory)).toBe(
      await hostingIdentityForLaunch(profileDirectory)
    )
  })

  it('attaches under a different identity for a different Orca profile', async () => {
    expect(
      await hostingIdentityForLaunch(mkdtempSync(join(tmpdir(), 'orca-host-wiring-')))
    ).not.toBe(await hostingIdentityForLaunch(mkdtempSync(join(tmpdir(), 'orca-host-wiring-'))))
  })

  it('attaches under the identity already stamped into the first window', async () => {
    await launch(mkdtempSync(join(tmpdir(), 'orca-host-wiring-')))

    // Why the stamp is read first: window creation puts the id in the renderer's argv long before
    // any environment pairs, and a renderer holding a different id than the lease stops
    // recognizing the pages it is itself hosting.
    const { getBrowserClientHostId } = await import('./browser-client-host-id')
    const stamped = getBrowserClientHostId()

    expect(await hostingIdentity()).toBe(stamped)
  })

  it('keeps hosting on a process-local identity when no profile was ever resolved', async () => {
    vi.resetModules()
    createHostCallbacks.length = 0
    hostOptions.length = 0

    // Why not a throw: an unresolvable profile costs survival across a relaunch, not this session.
    const { getBrowserClientHostId } = await import('./browser-client-host-id')
    expect(await hostingIdentity()).toBe(getBrowserClientHostId())
  })
})
