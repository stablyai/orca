import { describe, expect, it, vi } from 'vitest'

const { exitListeners, shutdownMock } = vi.hoisted(() => {
  const listeners: ((payload: { id: string }) => void)[] = []
  return { exitListeners: listeners, shutdownMock: vi.fn() }
})

vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class {
    onDispose = vi.fn()
    dispose = vi.fn()
    isDisposed = vi.fn(() => false)
  }
}))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(async () => ({}))
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  allocateSshPtyProviderGeneration: vi.fn(() => 41),
  closeSshPtyOutputGeneration: vi.fn()
}))
vi.mock('../ipc/pty/provider/registry', () => ({ sshProvidersByGeneration: new Map() }))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class {
    providerGeneration = 41
    onData = vi.fn()
    onReplay = vi.fn()
    onExit = (listener: (payload: { id: string }) => void) => exitListeners.push(listener)
    listProcesses = vi.fn(async () => [{ id: SERVED }, { id: UNSERVED }])
    shutdown = shutdownMock
    dispose = vi.fn()
  }
}))

import { legacyRelayBridge, SshLegacyRelayRoute } from './ssh-legacy-relay-route'

const SERVED = 'ssh:target-1@@pty2:old:1'
const UNSERVED = 'ssh:target-1@@pty2:old:2'

describe('legacyRelayBridge', () => {
  it("runs the old build's own bridge from its version directory", () => {
    const bridge = legacyRelayBridge(
      '/usr/bin/node',
      '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock'
    )

    expect(bridge).toEqual({
      relayDir: '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122',
      connectCommand:
        "cd '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122' && '/usr/bin/node' relay.js --connect " +
        "--sock-path '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock' " +
        "--credential-file '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock.credential'",
      versionCommand: "cat '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122'/.version"
    })
  })

  it('declines an endpoint that does not sit in its own version directory', () => {
    expect(
      legacyRelayBridge('/usr/bin/node', '/tmp/.orca-relay-1000/relay-1a2b/relay-92ff.sock')
    ).toBeNull()
    expect(legacyRelayBridge('/usr/bin/node', '/home/dev/.orca-remote/relay-92ff.sock')).toBeNull()
  })
})

describe('SshLegacyRelayRoute', () => {
  it('stops holding an unserved PTY that exits, while it keeps serving another', async () => {
    const sink = { data: vi.fn(), exit: vi.fn(), replay: vi.fn() }
    const route = await SshLegacyRelayRoute.open({
      targetId: 'target-1',
      sockPath: '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock',
      nodePath: '/usr/bin/node',
      clientInstanceId: 'this-build',
      openTransport: vi.fn(),
      readText: vi.fn(async () => '0.1.0+f6e4b640b122\n'),
      sink
    })
    route!.beginServing(SERVED)

    for (const listener of exitListeners) {
      listener({ id: UNSERVED })
    }

    expect(route!.heldPtyIds()).toEqual([SERVED])
    expect(route!.holds(UNSERVED)).toBe(false)
    expect(route!.serves(SERVED)).toBe(true)
    expect(sink.exit).not.toHaveBeenCalled()
  })

  it('settles a shutdown whose PTY exit closed the route before the reply arrived', async () => {
    exitListeners.length = 0
    const route = await openRoute()
    route.beginServing(SERVED)
    // The exit arrives first and closes the route (its last served PTY), disposing the mux.
    shutdownMock.mockImplementationOnce(async () => {
      for (const listener of exitListeners) {
        listener({ id: SERVED })
      }
      throw new Error('Multiplexer disposed')
    })
    await expect(route.provider.shutdown(SERVED, { immediate: true })).resolves.toBeUndefined()
    expect(route.serves(SERVED)).toBe(false)

    shutdownMock.mockRejectedValueOnce(new Error('Multiplexer disposed'))
    await expect(route.provider.shutdown(UNSERVED, { immediate: true })).rejects.toThrow(
      'Multiplexer disposed'
    )
  })

  it('keeps a route a second pane started serving while a stop on the first was settling', async () => {
    exitListeners.length = 0
    const route = await openRoute()
    route.beginServing(SERVED)
    let settleStop: () => void = () => {}
    const stop = route.track(
      () =>
        new Promise<void>((resolve) => {
          settleStop = resolve
        })
    )
    // The stopped PTY's exit lands before the stop's reply, deferring the hang-up.
    for (const listener of exitListeners) {
      listener({ id: SERVED })
    }
    route.beginServing(UNSERVED)

    settleStop()
    await stop

    expect(route.serves(UNSERVED)).toBe(true)
    expect(route.heldPtyIds()).toEqual([UNSERVED])

    for (const listener of exitListeners) {
      listener({ id: UNSERVED })
    }
    expect(route.serves(UNSERVED)).toBe(false)
    expect(route.heldPtyIds()).toEqual([])
  })
})

async function openRoute(): Promise<SshLegacyRelayRoute> {
  const route = await SshLegacyRelayRoute.open({
    targetId: 'target-1',
    sockPath: '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock',
    nodePath: '/usr/bin/node',
    clientInstanceId: 'this-build',
    openTransport: vi.fn(),
    readText: vi.fn(async () => '0.1.0+f6e4b640b122\n'),
    sink: { data: vi.fn(), exit: vi.fn(), replay: vi.fn() }
  })
  return route!
}
