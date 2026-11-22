import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import { AGENT_AWAKE_STATUS_STALE_AFTER_MS } from './agent-awake-status-lease'
import { WslHostAgentAwake } from './wsl-host-agent-awake'

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn() }
}))

const START = 10_000_000_000
const HOUR = 60 * 60 * 1000
let now = START

function createService() {
  const assertion = { start: vi.fn(() => true), stop: vi.fn(), dispose: vi.fn() }
  const blocker = { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) }
  const service = new AgentAwakeService({
    blocker,
    linuxAssertion: assertion,
    macosAssertion: assertion,
    logger: { debug: vi.fn(), warn: vi.fn() },
    now: () => now,
    platform: 'win32',
    powerMonitor: null
  })
  service.setMode('auto')
  return service
}

function frame(type: 'snapshots' | 'updated', hostUpdatedAt: number | null) {
  const tabs = [
    {
      type: 'terminal',
      id: 't1',
      agentStatus:
        hostUpdatedAt === null
          ? { state: 'done', updatedAt: 1 }
          : { state: 'working', updatedAt: hostUpdatedAt }
    }
  ]
  return type === 'snapshots'
    ? { type, snapshots: [{ worktree: 'wt-1', tabs }] }
    : { type, worktree: 'wt-1', tabs }
}

/** A WSL host service and host stream with no renderer involved. */
function createHost(service: AgentAwakeService, failedOpens = 0) {
  let opensToFail = failedOpens
  let hostState: string | null = 'ready'
  let hostsChanged = (): void => {}
  let send = (_frame: unknown): void => {}
  let endStream = (): void => {}
  const close = vi.fn()
  const watcher = new WslHostAgentAwake({
    listHosts: () => (hostState ? [{ environmentId: 'wsl-env', state: hostState }] : []),
    onHostsChanged: (listener) => {
      hostsChanged = listener
      return () => {}
    },
    openStream: async (_environmentId, handlers) => {
      if (opensToFail > 0) {
        opensToFail -= 1
        throw new Error('host did not answer')
      }
      send = handlers.onFrame
      endStream = handlers.onEnd
      return { close }
    },
    report: (environmentId, statuses) => service.setWslHostStatuses(environmentId, statuses),
    now: () => now
  })
  watchers.push(watcher)
  return {
    close,
    send: (value: unknown) => send(value),
    endStream: () => endStream(),
    setHostState: async (state: string | null) => {
      hostState = state
      hostsChanged()
      await Promise.resolve()
    }
  }
}

const watchers: WslHostAgentAwake[] = []
beforeEach(() => {
  now = START
  vi.useFakeTimers()
})
afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.dispose()
  }
  vi.useRealTimers()
})

describe('keep-awake for agents on WSL hosts', () => {
  it('keeps the machine awake while a host agent works, with no window involved', async () => {
    const service = createService()
    const host = createHost(service)
    await Promise.resolve()

    host.send({ type: 'snapshots', snapshots: [] })
    host.send(frame('updated', 500))
    expect(service.getStatus().active).toBe(true)

    host.send(frame('updated', null))
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('does not count a row already working when the app first sees the host', async () => {
    const service = createService()
    const host = createHost(service)
    await Promise.resolve()

    host.send(frame('snapshots', 500))
    expect(service.getStatus().active).toBe(false)
    host.send(frame('updated', 500))
    expect(service.getStatus().active).toBe(false)

    host.send(frame('updated', 600))
    expect(service.getStatus().active).toBe(true)
    service.dispose()
  })

  it('stops counting as soon as the host disconnects or its stream drops', async () => {
    const service = createService()
    const host = createHost(service)
    await Promise.resolve()
    host.send({ type: 'snapshots', snapshots: [] })

    host.send(frame('updated', 500))
    expect(service.getStatus().active).toBe(true)
    host.endStream()
    expect(service.getStatus().active).toBe(false)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    host.send(frame('snapshots', 600))
    expect(service.getStatus().active).toBe(true)
    await host.setHostState('reconnecting')
    expect(host.close).toHaveBeenCalled()
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('retries a host whose stream failed to open instead of giving up on it', async () => {
    const service = createService()
    const host = createHost(service, 1)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    host.send({ type: 'snapshots', snapshots: [] })
    host.send(frame('updated', 500))
    expect(service.getStatus().active).toBe(true)
    service.dispose()
  })

  it('keeps the first receipt when the same evidence returns after a stream or host reconnect', async () => {
    const service = createService()
    const host = createHost(service)
    await Promise.resolve()
    host.send({ type: 'snapshots', snapshots: [] })
    host.send(frame('updated', 500))

    now += HOUR
    host.endStream()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    host.send(frame('snapshots', 500))
    expect(service.getStatus().active).toBe(true)

    now += HOUR / 2
    await host.setHostState('reconnecting')
    await host.setHostState('ready')
    host.send(frame('snapshots', 500))
    expect(service.getStatus().active).toBe(true)

    // Still the same stuck row: its lease runs from the first receipt, so it lapses on time.
    now = START + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('times a host agent by this machine’s receipt, not the host clock', async () => {
    const service = createService()
    const host = createHost(service)
    await Promise.resolve()
    host.send({ type: 'snapshots', snapshots: [] })

    // A host clock hours behind this machine must not make a live agent look stale.
    host.send(frame('updated', 0))
    expect(service.getStatus().active).toBe(true)
    service.dispose()
  })

  it('lets a future-stamped row lapse like any other', () => {
    const service = createService()
    service.setWslHostStatuses('wsl-env', [{ paneKey: 'p', receivedAt: START * 2 }])
    expect(service.getStatus().active).toBe(true)

    now = START + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('does not defer local repo maintenance for host agents', () => {
    const service = createService()
    service.setWslHostStatuses('wsl-env', [{ paneKey: 'p', receivedAt: START }])
    expect(service.getStatus().active).toBe(true)
    expect(service.getWorkingAgentCount()).toBe(0)
    service.dispose()
  })
})
