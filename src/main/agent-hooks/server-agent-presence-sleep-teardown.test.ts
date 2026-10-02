import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import { TerminalIntentionalStops } from '../runtime/terminal-intentional-stops'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import type { AgentPresenceReleaseIpcPayload } from '../../shared/agent-status-ipc-payload'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

const SLEEP_WINDOW_MS = 12_000
const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} satisfies AgentProcessPresence

class TeardownServer extends AgentHookServer {
  publish(overrides: Partial<AgentHookEventPayload> = {}): void {
    this.applyNormalizedStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      agentPresence: owner,
      payload: { agentType: 'claude', state: 'working', prompt: 'task' },
      ...overrides
    })
  }

  endSession(): void {
    this.publish({
      hookEventName: 'SessionEnd',
      providerSessionOnly: true,
      agentPresence: { ...owner, ended: true }
    })
  }
}

const servers: TeardownServer[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

/** A server whose probe reads the runtime's stop register for the pane's one PTY. */
function sleepingPaneServer(stops: TerminalIntentionalStops): {
  server: TeardownServer
  endedEvents: unknown[]
  releases: AgentPresenceReleaseIpcPayload[]
} {
  const server = new TeardownServer()
  servers.push(server)
  const endedEvents: unknown[] = []
  const releases: AgentPresenceReleaseIpcPayload[] = []
  server.setListener((event) => {
    if (event.agentPresence?.ended) {
      endedEvents.push(event)
    }
  })
  server.setAgentPresenceReleaseListener((release) => releases.push(release))
  server.setPaneTerminalSleepStopProbe(
    (paneKey) =>
      paneKey === PANE &&
      stops.reversibleStopPtyIdsInFlightWithin(SLEEP_WINDOW_MS).includes('pty-1')
  )
  server.publish()
  return { server, endedEvents, releases }
}

describe('SessionEnd while Orca sleeps the terminal', () => {
  it('releases the owner instead of ending it, so no exit reaches any reader', () => {
    const stops = new TerminalIntentionalStops()
    const { server, endedEvents, releases } = sleepingPaneServer(stops)
    stops.mark('pty-1', 'reversible', null)

    server.endSession()

    expect(endedEvents).toEqual([])
    expect(releases).toEqual([{ paneKey: PANE, process: owner.process }])
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('still ends the owner when the terminal lives on', () => {
    const { server, endedEvents, releases } = sleepingPaneServer(new TerminalIntentionalStops())

    server.endSession()

    expect(endedEvents).toHaveLength(1)
    expect(releases).toEqual([])
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ ...owner, ended: true })
  })

  it.each([
    ['a sleep that failed', (settle: (stopped: boolean) => void) => settle(false)],
    ['a sleep that landed', (settle: (stopped: boolean) => void) => settle(true)],
    ['a sleep stop older than its window', () => vi.setSystemTime(Date.now() + SLEEP_WINDOW_MS + 1)]
  ])('treats a later /exit after %s as the user exiting', (_case, after) => {
    vi.useFakeTimers()
    const stops = new TerminalIntentionalStops()
    const { server, endedEvents } = sleepingPaneServer(stops)
    after(stops.mark('pty-1', 'reversible', null))

    server.endSession()

    expect(endedEvents).toHaveLength(1)
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ ...owner, ended: true })
  })
})
