import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentAutoResumeService,
  BANNER_RESET_GRACE_MS,
  MAX_RESUME_ATTEMPTS,
  POST_SEND_VERIFY_MS,
  type AgentAutoResumeNotification
} from './agent-auto-resume-service'
import type { UsageLimitStallEvent, UsageLimitStallSnapshot } from './runtime/orca-runtime'
import type { UsageLimitStallReason } from '../shared/agent-auto-resume-types'

const MENU_GRACE_MS = 5 * 60 * 1000
const PTY = 'pty-1'
const HANDLE = 'handle-1'

function detectedEvent(
  overrides: Partial<Extract<UsageLimitStallEvent, { kind: 'detected' }>> = {}
): UsageLimitStallEvent {
  return {
    kind: 'detected',
    ptyId: PTY,
    handle: HANDLE,
    worktreeId: 'repo::wt',
    paneKey: 'tab:leaf',
    provider: 'claude',
    reason: 'usage-limit-banner',
    resetsAt: null,
    detectedAt: Date.now(),
    ...overrides
  }
}

type StallState = { present: boolean; agentWorking: boolean; reason: UsageLimitStallReason }

function makeHarness(providerResetAt: number | null = null) {
  const sendKeys = vi.fn<
    (handle: string, action: { text?: string; enter?: boolean }) => Promise<void>
  >(() => Promise.resolve())
  const notify = vi.fn<(n: AgentAutoResumeNotification) => void>()
  const snapshots: number[] = []
  const stall: StallState = { present: true, agentWorking: false, reason: 'usage-limit-banner' }
  const verifyStall = vi.fn<(ptyId: string) => UsageLimitStallSnapshot | null>((ptyId) => ({
    ptyId,
    handle: HANDLE,
    worktreeId: 'repo::wt',
    paneKey: 'tab:leaf',
    provider: 'claude',
    reason: stall.reason,
    resetsAt: null,
    detectedAt: 0,
    present: stall.present,
    agentWorking: stall.agentWorking
  }))
  const service = new AgentAutoResumeService({
    verifyStall,
    sendKeys,
    getMenuGraceMs: () => MENU_GRACE_MS,
    getProviderResetAt: () => providerResetAt,
    notify,
    onSnapshot: (snapshot) => snapshots.push(snapshot.entries.length)
  })
  service.setEnabled(true)
  return { service, sendKeys, notify, verifyStall, stall, snapshots }
}

describe('AgentAutoResumeService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('notifies on detection and tracks the stall', () => {
    const { service, notify, snapshots } = makeHarness()
    service.handleEvent(detectedEvent())
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'detected' }))
    expect(snapshots.at(-1)).toBe(1)
    expect(service.getSnapshot().entries[0]).toMatchObject({
      ptyId: PTY,
      reason: 'usage-limit-banner'
    })
  })

  it('presses Enter on the wait-for-reset menu only after the idle grace', async () => {
    const { service, sendKeys, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS - 1000)
    expect(sendKeys).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(HANDLE, { enter: true })
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('does not poke the menu if a human already resumed the agent (working)', async () => {
    const { service, sendKeys, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))
    stall.agentWorking = true

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('resends "continue" for a banner after resetsAt + grace', async () => {
    const { service, sendKeys, stall } = makeHarness()
    stall.reason = 'usage-limit-banner'
    const resetsAt = Date.now() + 60_000
    service.handleEvent(detectedEvent({ resetsAt }))

    await vi.advanceTimersByTimeAsync(60_000 + BANNER_RESET_GRACE_MS - 1000)
    expect(sendKeys).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(sendKeys).toHaveBeenCalledWith(HANDLE, { text: 'continue', enter: true })
  })

  it('uses the provider resetsAt when the banner carries none', async () => {
    const providerResetAt = Date.now() + 120_000
    const { service, sendKeys } = makeHarness(providerResetAt)
    service.handleEvent(detectedEvent({ resetsAt: null }))

    await vi.advanceTimersByTimeAsync(120_000 + BANNER_RESET_GRACE_MS - 500)
    expect(sendKeys).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(sendKeys).toHaveBeenCalledOnce()
  })

  it('does nothing when the banner cleared before the timer fired', async () => {
    const { service, sendKeys, notify, stall } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    stall.present = false

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('dedups repeated detections of the same stall (arms one timer)', async () => {
    const { service, sendKeys } = makeHarness()
    const resetsAt = Date.now() + 1000
    service.handleEvent(detectedEvent({ resetsAt }))
    service.handleEvent(detectedEvent({ resetsAt }))
    service.handleEvent(detectedEvent({ resetsAt }))
    expect(service.getSnapshot().entries).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).toHaveBeenCalledOnce()
  })

  it('re-arms when the reason changes (banner → menu)', async () => {
    const { service, sendKeys, stall } = makeHarness()
    service.handleEvent(
      detectedEvent({ reason: 'usage-limit-banner', resetsAt: Date.now() + 1_000_000 })
    )
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))
    expect(service.getSnapshot().entries[0]).toMatchObject({ reason: 'usage-limit-menu' })

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(HANDLE, { enter: true })
  })

  it('retries up to the cap then gives up and notifies', async () => {
    const { service, sendKeys, notify } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))

    // First attempt.
    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    // Post-send verify still stalled → second attempt.
    await vi.advanceTimersByTimeAsync(POST_SEND_VERIFY_MS)
    // Post-send verify still stalled → give up.
    await vi.advanceTimersByTimeAsync(POST_SEND_VERIFY_MS)

    expect(sendKeys).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('stops tracking and clears the timer when the agent resumes (cleared)', async () => {
    const { service, sendKeys } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    service.handleEvent({ kind: 'cleared', ptyId: PTY })
    expect(service.getSnapshot().entries).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('notifies and stops tracking when the PTY exits while limited', () => {
    const { service, notify, sendKeys } = makeHarness()
    service.handleEvent(detectedEvent())
    service.handleEvent({
      kind: 'exited',
      ptyId: PTY,
      worktreeId: 'repo::wt',
      paneKey: 'tab:leaf',
      exitCode: 1
    })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dead-pty' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('ignores events while disabled and drops pending timers on opt-out', async () => {
    const { service, sendKeys } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    service.setEnabled(false)
    expect(service.getSnapshot().entries).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()

    // A detection while disabled is a no-op.
    service.handleEvent(detectedEvent())
    expect(service.getSnapshot().entries).toHaveLength(0)
  })
})
