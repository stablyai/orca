import { describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import { WslHostAgentAwake } from './wsl-host-agent-awake'
import { runWslHostAgentAwakeWhileAuto } from './wsl-host-agent-awake-mode-gate'

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn() }
}))

const now = 10_000_000_000

function workingSnapshots(hostObservedAt: number) {
  return {
    type: 'snapshots',
    snapshots: [
      {
        worktree: 'wt-1',
        tabs: [
          {
            type: 'terminal',
            id: 't1',
            agentStatus: { state: 'working', updatedAt: hostObservedAt }
          }
        ]
      }
    ]
  }
}

function setup() {
  const assertion = { start: vi.fn(() => true), stop: vi.fn(), dispose: vi.fn() }
  const service = new AgentAwakeService({
    blocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
    linuxAssertion: assertion,
    macosAssertion: assertion,
    logger: { debug: vi.fn(), warn: vi.fn() },
    now: () => now,
    platform: 'win32',
    powerMonitor: null
  })
  const close = vi.fn()
  let send = (_frame: unknown): void => {}
  const openStream = vi.fn(async (_id: string, handlers: { onFrame: (f: unknown) => void }) => {
    send = handlers.onFrame
    return { close }
  })
  const stop = runWslHostAgentAwakeWhileAuto(
    service,
    () =>
      new WslHostAgentAwake({
        listHosts: () => [{ environmentId: 'wsl-env', state: 'ready' }],
        onHostsChanged: () => () => {},
        openStream,
        report: (environmentId, statuses) => service.setWslHostStatuses(environmentId, statuses),
        now: () => now
      })
  )
  return { service, openStream, close, stop, send: (frame: unknown) => send(frame) }
}

describe('runWslHostAgentAwakeWhileAuto', () => {
  it('opens no host stream while keep-awake is Off or On', () => {
    const { service, openStream } = setup()
    expect(openStream).not.toHaveBeenCalled()
    service.setMode('on')
    expect(openStream).not.toHaveBeenCalled()
  })

  it('starts on Auto and tears the stream and its counts down when Auto is left', async () => {
    const { service, openStream, close, send } = setup()
    service.setMode('auto')
    expect(openStream).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    send(workingSnapshots(1))
    send({ type: 'updated', ...workingSnapshots(2).snapshots[0] })
    expect(service.getStatus()).toEqual({ mode: 'auto', active: true })

    service.setMode('off')
    expect(close).toHaveBeenCalledTimes(1)
    // Back on Auto, the host's old receipt is gone: the already-working row waits for fresh evidence.
    service.setMode('auto')
    expect(openStream).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    send(workingSnapshots(2))
    expect(service.getStatus()).toEqual({ mode: 'auto', active: false })
    send({ type: 'updated', ...workingSnapshots(3).snapshots[0] })
    expect(service.getStatus()).toEqual({ mode: 'auto', active: true })
  })

  it('closes the stream and ignores later mode changes once stopped', async () => {
    const { service, openStream, close, stop } = setup()
    service.setMode('auto')
    await Promise.resolve()
    stop()
    expect(close).toHaveBeenCalledTimes(1)
    service.setMode('off')
    service.setMode('auto')
    expect(openStream).toHaveBeenCalledTimes(1)
  })
})
