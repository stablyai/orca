import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleInstallController, IDLE_INSTALL_GRACE_MS } from './updater-idle-install'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'
import type { AgentHookStatusChangeEntry } from './agent-hooks/server'
import type { UpdateStatus } from '../shared/types'

const NOW = 1_000_000

function workingAgent(
  overrides: Partial<AgentHookStatusChangeEntry> = {}
): AgentHookStatusChangeEntry {
  return {
    state: 'working',
    receivedAt: NOW,
    observedInCurrentRuntime: true,
    ...overrides
  }
}

function createHarness(
  initialStatus: UpdateStatus = { state: 'available', version: '1.4.30', changelog: null },
  options: {
    now?: () => number
    graceMs?: number
    staleAfterMs?: number
  } = {}
) {
  const download = vi.fn()
  const install = vi.fn()
  const onDecorationChange = vi.fn()
  let status = initialStatus
  let agents: AgentHookStatusChangeEntry[] = []

  const controller = new IdleInstallController({
    download,
    install,
    getStatus: () => status,
    getActiveAgentSnapshot: () => agents,
    onDecorationChange,
    now: options.now ?? (() => NOW),
    graceMs: options.graceMs,
    staleAfterMs: options.staleAfterMs
  })

  return {
    controller,
    download,
    install,
    onDecorationChange,
    setStatus(next: UpdateStatus) {
      status = next
      controller.handleUpdaterStatus(next)
    },
    setAgents(next: AgentHookStatusChangeEntry[]) {
      agents = next
      controller.onAgentStatusChange()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('IdleInstallController', () => {
  it('starts the download immediately on arm', () => {
    const h = createHarness()
    h.controller.arm()
    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.controller.isArmed()).toBe(true)
  })

  it('installs after the grace window when downloaded and no agents are working', () => {
    const h = createHarness()
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    expect(h.controller.getDecoration()).toEqual({ phase: 'grace', activeAgentCount: 0 })
    expect(h.install).not.toHaveBeenCalled()

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
    expect(h.controller.isArmed()).toBe(false)
    expect(h.controller.getDecoration()).toBeNull()
  })

  it('does not install while an agent is working', () => {
    const h = createHarness()
    h.setAgents([workingAgent()])
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    expect(h.controller.getDecoration()).toEqual({ phase: 'waiting-for-idle', activeAgentCount: 1 })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS * 2)
    expect(h.install).not.toHaveBeenCalled()
  })

  it('installs once the last working agent goes idle (after grace)', () => {
    const h = createHarness()
    h.setAgents([workingAgent()])
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })
    expect(h.install).not.toHaveBeenCalled()

    h.setAgents([workingAgent({ state: 'done' })])
    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('resets the grace window if an agent starts working mid-grace', () => {
    const h = createHarness()
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS - 1)
    h.setAgents([workingAgent()]) // becomes busy just before grace elapses
    expect(h.controller.getDecoration()).toEqual({ phase: 'waiting-for-idle', activeAgentCount: 1 })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).not.toHaveBeenCalled()

    h.setAgents([]) // idle again — fresh grace window
    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale (crashed) working agent so the install is not blocked forever', () => {
    const h = createHarness()
    h.setAgents([workingAgent({ receivedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 })])
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    expect(h.controller.getDecoration()).toEqual({ phase: 'grace', activeAgentCount: 0 })
    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('re-evaluates when a working agent becomes stale without a final hook', () => {
    let now = NOW
    const staleAfterMs = 1_000
    const graceMs = 50
    const h = createHarness(undefined, {
      now: () => now,
      graceMs,
      staleAfterMs
    })
    h.setAgents([workingAgent({ receivedAt: NOW })])
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    expect(h.controller.getDecoration()).toEqual({ phase: 'waiting-for-idle', activeAgentCount: 1 })

    now = NOW + staleAfterMs + 1
    vi.advanceTimersByTime(staleAfterMs + 1)
    expect(h.controller.getDecoration()).toEqual({ phase: 'grace', activeAgentCount: 0 })

    vi.advanceTimersByTime(graceMs)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('ignores agents not observed in the current runtime', () => {
    const h = createHarness()
    h.setAgents([workingAgent({ observedInCurrentRuntime: false })])
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('waits for the download to finish before counting grace', () => {
    const h = createHarness()
    h.controller.arm()
    // Still downloading — idle agents should not start the grace clock.
    h.setStatus({ state: 'downloading', percent: 40, version: '1.4.30' })
    expect(h.controller.getDecoration()).toEqual({ phase: 'downloading', activeAgentCount: 0 })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).not.toHaveBeenCalled()

    h.setStatus({ state: 'downloaded', version: '1.4.30' })
    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('cancel disarms, clears the decoration, and never installs', () => {
    const h = createHarness()
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    h.controller.cancel()
    expect(h.controller.isArmed()).toBe(false)
    expect(h.controller.getDecoration()).toBeNull()

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS)
    expect(h.install).not.toHaveBeenCalled()
  })

  it('disarms when the updater cycle resets to a no-update state', () => {
    const h = createHarness()
    h.controller.arm()
    h.setStatus({ state: 'not-available' })

    expect(h.controller.isArmed()).toBe(false)
    expect(h.controller.getDecoration()).toBeNull()
  })

  it('is idempotent — a second arm() does not restart the grace clock or re-download', () => {
    const h = createHarness()
    h.controller.arm()
    h.setStatus({ state: 'downloaded', version: '1.4.30' })

    vi.advanceTimersByTime(IDLE_INSTALL_GRACE_MS - 1)
    h.controller.arm() // double-tap mid-grace must not reset the window
    vi.advanceTimersByTime(1)

    expect(h.install).toHaveBeenCalledTimes(1)
    expect(h.download).toHaveBeenCalledTimes(1)
  })

  it('does nothing when agent status changes while not armed', () => {
    const h = createHarness()
    h.setAgents([workingAgent()])
    expect(h.controller.getDecoration()).toBeNull()
    expect(h.onDecorationChange).not.toHaveBeenCalled()
  })
})
