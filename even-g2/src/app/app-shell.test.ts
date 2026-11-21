// Finding #6: pairing/removing a host after startup must update the already-running shell, not
// just the phone page's own DOM. Exercises startAppShell + a shared ProfileController against a
// real OrcaSocketClient (via OrcaHandshakeTestServer) over MockGlassesBridge.
import { afterEach, describe, expect, it } from 'vitest'
import { MockGlassesBridge } from '../sim/mock-glasses-bridge'
import { createMemorySocketPair } from '../sim/memory-socket-pair'
import { toWebSocketLike } from '../sim/memory-socket-web-socket-adapter'
import type { WebSocketLike } from '../transport/orca-socket-client'
import type { GlassesHostProfile } from '../state/hud-store'
import { startAppShell, type AppShell } from './app-shell'
import { ProfileController } from './profile-controller'
import { OrcaHandshakeTestServer } from './orca-handshake-test-server'

const DEVICE_TOKEN = 'device-token'

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function memoryProfileStore(): {
  load(): Promise<GlassesHostProfile[]>
  upsert(profile: GlassesHostProfile): Promise<void>
  remove(id: string): Promise<void>
} {
  let hosts: GlassesHostProfile[] = []
  return {
    load: async () => [...hosts],
    upsert: async (profile) => {
      hosts = [...hosts.filter((h) => h.id !== profile.id), profile]
    },
    remove: async (id) => {
      hosts = hosts.filter((h) => h.id !== id)
    }
  }
}

function profileFor(server: OrcaHandshakeTestServer, id: string): GlassesHostProfile {
  return {
    id,
    name: id,
    endpoint: 'memory://test',
    deviceToken: DEVICE_TOKEN,
    publicKeyB64: server.publicKeyB64,
    lastConnected: 0
  }
}

function socketFactoryFor(server: OrcaHandshakeTestServer): (url: string) => WebSocketLike {
  return (_url: string) => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    server.attach(serverSocket)
    return toWebSocketLike(clientSocket)
  }
}

describe('startAppShell profile reactivity', () => {
  let shell: AppShell | null = null

  afterEach(() => {
    shell?.stop()
    shell = null
  })

  it('connects the shell when a host is paired after startup (finding #6)', async () => {
    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const profiles = new ProfileController(memoryProfileStore())

    shell = await startAppShell({
      bridge: new MockGlassesBridge(),
      profiles,
      socketFactory: socketFactoryFor(server)
    })
    expect(shell.sessions.current()).toBeNull()

    await profiles.upsert(profileFor(server, 'host-new'))
    await flushMicrotasks()

    expect(shell.sessions.current()?.hostId).toBe('host-new')
    expect(shell.store.getState().hosts.map((h) => h.id)).toContain('host-new')
  })

  it('tears down the session when its profile is removed (finding #6)', async () => {
    const server = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const store = memoryProfileStore()
    await store.upsert(profileFor(server, 'host-a'))
    const profiles = new ProfileController(store)

    shell = await startAppShell({
      bridge: new MockGlassesBridge(),
      profiles,
      socketFactory: socketFactoryFor(server)
    })
    await flushMicrotasks()
    expect(shell.sessions.current()?.hostId).toBe('host-a')

    await profiles.remove('host-a')
    await flushMicrotasks()

    expect(shell.sessions.current()).toBeNull()
    expect(shell.store.getState().hosts.map((h) => h.id)).not.toContain('host-a')
  })

  it('does not steal the active session when a second, unrelated host is paired', async () => {
    const serverA = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    const store = memoryProfileStore()
    await store.upsert(profileFor(serverA, 'host-a'))
    const profiles = new ProfileController(store)

    shell = await startAppShell({
      bridge: new MockGlassesBridge(),
      profiles,
      socketFactory: socketFactoryFor(serverA)
    })
    await flushMicrotasks()
    expect(shell.sessions.current()?.hostId).toBe('host-a')

    const serverB = new OrcaHandshakeTestServer({
      deviceToken: DEVICE_TOKEN,
      protocolVersion: 3,
      minCompatibleMobileVersion: 2
    })
    await profiles.upsert(profileFor(serverB, 'host-b'))
    await flushMicrotasks()

    expect(shell.sessions.current()?.hostId).toBe('host-a')
    expect(shell.store.getState().hosts.map((h) => h.id)).toEqual(
      expect.arrayContaining(['host-a', 'host-b'])
    )
  })
})
