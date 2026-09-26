import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentAutoResumeService,
  BANNER_RESET_GRACE_MS,
  BANNER_UNKNOWN_RESET_DELAY_MS,
  INDETERMINATE_RETRY_DELAY_MS,
  MAX_INDETERMINATE_RETRIES,
  MAX_RESUME_ATTEMPTS,
  POST_SEND_VERIFY_MS,
  type AgentAutoResumeNotification
} from './agent-auto-resume-service'
import type { UsageLimitStallEvent, UsageLimitStallSnapshot } from './runtime/orca-runtime'
import type { UsageLimitStallReason } from '../shared/agent-auto-resume-types'
import { readUsageLimitMenu } from '../shared/usage-limit-menu-selection'

const MENU_GRACE_MS = 5 * 60 * 1000
const MENU_TAIL = '❯ 1. Stop and wait for the limit to reset\n  2. Upgrade your plan'
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

type StallState = {
  /** The recorded signal is still somewhere in the live tail — text presence
   *  only, which is where the runtime's own snapshot starts from. */
  signalled: boolean
  agentWorking: boolean
  reason: UsageLimitStallReason
  waitText: string
}

function makeHarness(providerResetAt: number | null = null) {
  const sendKeys = vi.fn<
    (handle: string, action: { text?: string; enter?: boolean }) => Promise<void>
  >(() => Promise.resolve())
  const notify = vi.fn<(n: AgentAutoResumeNotification) => void>()
  const snapshots: number[] = []
  const stall: StallState = {
    signalled: true,
    agentWorking: false,
    reason: 'usage-limit-banner',
    waitText: MENU_TAIL
  }
  // Derives the two flags from waitText exactly as getUsageLimitStallSnapshot
  // does, so these tests exercise the real classifier rather than a stand-in.
  const verifyStall = vi.fn<(ptyId: string) => UsageLimitStallSnapshot | null>((ptyId) => {
    const menu = stall.reason === 'usage-limit-menu' ? readUsageLimitMenu(stall.waitText) : null
    return {
      ptyId,
      handle: HANDLE,
      worktreeId: 'repo::wt',
      paneKey: 'tab:leaf',
      provider: 'claude',
      reason: stall.reason,
      resetsAt: null,
      detectedAt: 0,
      actionable: stall.signalled && (menu === null || menu.state === 'live'),
      indeterminate: stall.signalled && menu?.state === 'unreadable',
      blocksDelivery: stall.signalled && menu?.state !== 'dismissed',
      agentWorking: stall.agentWorking,
      waitText: stall.waitText
    }
  })
  const chooseMenuReset = vi.fn<
    (ptyId: string, handle: string, menuText: string) => Promise<boolean>
  >(() => Promise.resolve(true))
  // Mutable so a test can untick "Rate limit watcher" mid-wait, exactly as the
  // real predicate re-reads the armed tab set on every call.
  const watch = { enabled: true }
  const service = new AgentAutoResumeService({
    isWatchEnabled: () => watch.enabled,
    verifyStall,
    sendKeys,
    chooseMenuReset,
    getMenuGraceMs: () => MENU_GRACE_MS,
    getProviderResetAt: () => providerResetAt,
    notify,
    onSnapshot: (snapshot) => snapshots.push(snapshot.entries.length)
  })
  return { service, sendKeys, chooseMenuReset, notify, verifyStall, stall, snapshots, watch }
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

  it('selects the wait-for-reset row only after the idle grace', async () => {
    const { service, chooseMenuReset, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS - 1000)
    expect(chooseMenuReset).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(chooseMenuReset).toHaveBeenCalledExactlyOnceWith(PTY, HANDLE, MENU_TAIL)
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('gives up rather than guessing when the reset row cannot be identified', async () => {
    const { service, sendKeys, chooseMenuReset, notify, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    chooseMenuReset.mockResolvedValue(false)
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('re-reads an unreadable chooser instead of abandoning the stall', async () => {
    const { service, chooseMenuReset, notify, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    // One row with nothing above it to prove a chooser: the parser can classify
    // this frame neither way. A parked agent emits nothing that would re-detect
    // it, so dropping the entry here would park it for the whole limit window.
    stall.waitText = '❯ 1. Stop and wait for limit to reset'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(chooseMenuReset).not.toHaveBeenCalled()
    expect(service.getSnapshot().entries).toHaveLength(1)

    stall.waitText = MENU_TAIL
    await vi.advanceTimersByTimeAsync(INDETERMINATE_RETRY_DELAY_MS)
    expect(chooseMenuReset).toHaveBeenCalledOnce()
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
  })

  it('gives up — and says so — once the screen stays unreadable for the whole budget', async () => {
    const { service, chooseMenuReset, notify, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    stall.waitText = '❯ 1. Stop and wait for limit to reset'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(
      MENU_GRACE_MS + INDETERMINATE_RETRY_DELAY_MS * (MAX_INDETERMINATE_RETRIES + 1)
    )
    expect(chooseMenuReset).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('re-arms on a corrected reset time carried by a later banner', async () => {
    // The runtime re-parses the reset on every edge. Keeping the first one would
    // resend `continue` while the limit still had two minutes left to run.
    const { service, sendKeys } = makeHarness()
    const firstResetAt = Date.now() + 60_000
    service.handleEvent(detectedEvent({ resetsAt: firstResetAt }))
    service.handleEvent(detectedEvent({ resetsAt: firstResetAt + 120_000 }))
    expect(service.getSnapshot().entries).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(sendKeys).toHaveBeenCalledOnce()
  })

  it('leaves a replacement stall alone when the menu press gives up', async () => {
    const { service, sendKeys, chooseMenuReset, notify, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    chooseMenuReset.mockImplementation(() => {
      // The arrow/Enter sequence awaits a repaint pause, and a banner can land in
      // that window. It is a different stall with its own armed timer, so the
      // give-up below must not delete it by ptyId or notify about it.
      stall.reason = 'usage-limit-banner'
      service.handleEvent(
        detectedEvent({ reason: 'usage-limit-banner', resetsAt: Date.now() + 1000 })
      )
      return Promise.resolve(false)
    })
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).toHaveBeenCalledWith(HANDLE, { text: 'continue', enter: true })
  })

  it('presses a live menu even while the title still shows the working spinner', async () => {
    // The chooser interrupts a turn without ending it, so the interrupted
    // turn's spinner stays in the title for as long as the menu sits there.
    // 2026-08-27: that spinner made a four-hour menu stall read as "recovered".
    const { service, chooseMenuReset, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))
    stall.agentWorking = true

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(chooseMenuReset).toHaveBeenCalledExactlyOnceWith(PTY, HANDLE, MENU_TAIL)
  })

  it('stops quietly when the chooser was already handled by a human', async () => {
    // Dismissed-chooser text lingers in the retained tail (still `signalled`),
    // but resumed agent output below it means there is nothing left to press.
    // Transcript bullets and the input box are the parser's positive proof; an
    // unrecognised screen is a different case, re-read rather than dropped.
    const { service, chooseMenuReset, notify, stall } = makeHarness()
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))
    stall.agentWorking = true
    stall.waitText = [
      MENU_TAIL,
      '⏺ Edit(src/main/index.ts)',
      '⎿  Updated src/main/index.ts with 2 additions',
      '╭─────────────────────────────╮',
      '│ >                           │',
      '╰─────────────────────────────╯'
    ].join('\n')

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(chooseMenuReset).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries).toHaveLength(0)
  })

  it('stands down when the CLI is waiting out the limit itself', async () => {
    // Claude Code 2.1.234+ resumes the agent on its own. Acting here would send
    // a second `continue` into a session the CLI just auto-continued.
    const { service, sendKeys, notify } = makeHarness()
    service.handleEvent(detectedEvent({ reason: 'usage-limit-cli-waiting' }))

    expect(service.getSnapshot().entries).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BANNER_UNKNOWN_RESET_DELAY_MS + POST_SEND_VERIFY_MS)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('drops a wait already armed once the CLI starts its own countdown', async () => {
    // The plain banner can paint a frame before the countdown line replaces it,
    // so the watcher can be armed by the time the CLI takes over.
    const { service, sendKeys, stall } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    expect(service.getSnapshot().entries).toHaveLength(1)

    stall.reason = 'usage-limit-cli-waiting'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-cli-waiting' }))
    expect(service.getSnapshot().entries).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('sends Enter and nothing else at the CLI reset prompt', async () => {
    // "Your usage limit has reset · press enter to continue" — the limit is over,
    // so there is no reset to wait for, and text would land in the prompt the
    // keypress reopens rather than resuming anything.
    const { service, sendKeys, stall } = makeHarness()
    stall.reason = 'usage-limit-reset-prompt'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-reset-prompt' }))

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS - 1000)
    expect(sendKeys).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(HANDLE, { enter: true })
  })

  it('still treats a working title as recovery for banner stalls', async () => {
    const { service, sendKeys, stall } = makeHarness()
    stall.agentWorking = true
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
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
    stall.signalled = false

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
    const { service, chooseMenuReset, stall } = makeHarness()
    service.handleEvent(
      detectedEvent({ reason: 'usage-limit-banner', resetsAt: Date.now() + 1_000_000 })
    )
    stall.reason = 'usage-limit-menu'
    service.handleEvent(detectedEvent({ reason: 'usage-limit-menu' }))
    expect(service.getSnapshot().entries[0]).toMatchObject({ reason: 'usage-limit-menu' })

    await vi.advanceTimersByTimeAsync(MENU_GRACE_MS)
    expect(chooseMenuReset).toHaveBeenCalledExactlyOnceWith(PTY, HANDLE, MENU_TAIL)
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

  it('waits out a corrected reset that lands while the resend is in flight', async () => {
    // The banner repaints with a later reset exactly while `continue` is being
    // typed: the limit had not lifted, so that send was early. Spending the last
    // attempt at the post-send verify would burn it just as early and give up
    // 45 seconds into a wait of half an hour.
    const { service, sendKeys, notify } = makeHarness()
    let releaseSend = (): void => {}
    sendKeys.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve
        })
    )
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).toHaveBeenCalledTimes(1)

    const correctedIn = 30 * 60 * 1000
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + correctedIn }))
    releaseSend()
    await vi.advanceTimersByTimeAsync(POST_SEND_VERIFY_MS)

    expect(sendKeys).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(service.getSnapshot().entries[0]).toMatchObject({ phase: 'waiting' })

    await vi.advanceTimersByTimeAsync(correctedIn + BANNER_RESET_GRACE_MS)
    expect(sendKeys).toHaveBeenCalledTimes(2)
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

  it('never tracks a terminal the user has not marked', async () => {
    const { service, sendKeys, notify, watch } = makeHarness()
    watch.enabled = false

    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    expect(service.getSnapshot().entries).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('sends nothing when the watcher is unticked during the wait', async () => {
    const { service, sendKeys, watch } = makeHarness()
    service.handleEvent(detectedEvent({ resetsAt: Date.now() + 1000 }))
    expect(service.getSnapshot().entries).toHaveLength(1)

    // The reset wait can run for hours; the opt-in is re-read at action time so
    // an unticked terminal is dropped instead of poked.
    watch.enabled = false
    await vi.advanceTimersByTimeAsync(1000 + BANNER_RESET_GRACE_MS)

    expect(sendKeys).not.toHaveBeenCalled()
    expect(service.getSnapshot().entries).toHaveLength(0)
  })
})
