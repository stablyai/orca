import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import {
  getPendingTerminalHandleRecoveryContextKey,
  hasPendingTerminalHandleRecoveryNeed,
  PendingTerminalHandleRecoveryBudget,
  PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS
} from './pending-terminal-handle-recovery'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome
} from './mobile-session-tabs-stream-health'

const TAB_ID = 'tab-1::f47ac10b-58cc-4372-a567-0e02b2c3d479'

function terminalTab(terminal: string | null): MobileSessionTab {
  return {
    type: 'terminal',
    id: TAB_ID,
    title: 'zsh',
    parentTabId: 'tab-1',
    leafId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    status: terminal === null ? 'pending-handle' : 'ready',
    terminal,
    isActive: true
  }
}

function snapshot(terminal: string | null, type?: 'snapshot' | 'updated'): SessionTabsResult {
  return {
    worktree: 'id:repo::worktree',
    publicationEpoch: 'host:1',
    snapshotVersion: 1,
    tabs: [terminalTab(terminal)],
    activeTabId: TAB_ID,
    activeTabType: 'terminal',
    ...(type ? { type } : {})
  } as SessionTabsResult
}

describe('hasPendingTerminalHandleRecoveryNeed', () => {
  it('reports a need while the active terminal tab has no handle', () => {
    expect(hasPendingTerminalHandleRecoveryNeed([terminalTab(null)], TAB_ID)).toBe(true)
  })

  it('clears once the host publishes the materialized handle', () => {
    expect(hasPendingTerminalHandleRecoveryNeed([terminalTab('term-1')], TAB_ID)).toBe(false)
  })

  it('ignores a pending terminal the user is not looking at', () => {
    const other: MobileSessionTab = {
      type: 'markdown',
      id: 'md-1',
      title: 'NOTES.md',
      filePath: '/w/NOTES.md',
      relativePath: 'NOTES.md',
      isDirty: false,
      isActive: false,
      documentVersion: '1'
    }
    expect(hasPendingTerminalHandleRecoveryNeed([terminalTab(null), other], 'md-1')).toBe(false)
  })

  it('reports no need with no selection or an unknown selection', () => {
    expect(hasPendingTerminalHandleRecoveryNeed([terminalTab(null)], null)).toBe(false)
    expect(hasPendingTerminalHandleRecoveryNeed([terminalTab(null)], 'gone')).toBe(false)
  })

  it('keeps recovery contexts distinct when tab identifiers contain separators', () => {
    const first = { ...terminalTab(null), id: 'a:b', parentTabId: 'c' }
    const second = { ...terminalTab(null), id: 'a', parentTabId: 'b:c' }

    expect(getPendingTerminalHandleRecoveryContextKey([first], first.id)).not.toBe(
      getPendingTerminalHandleRecoveryContextKey([second], second.id)
    )
  })
})

describe('PendingTerminalHandleRecoveryBudget', () => {
  it('parks after the bounded attempt window and resets for a new terminal', () => {
    const budget = new PendingTerminalHandleRecoveryBudget()
    for (let attempt = 1; attempt <= PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS; attempt += 1) {
      expect(budget.take('terminal-a')).toEqual({
        allowed: true,
        parked: false
      })
    }
    expect(budget.take('terminal-a')).toEqual({ allowed: false, parked: true })
    expect(budget.take('terminal-b')).toEqual({ allowed: true, parked: false })
  })

  it('resets the current terminal budget explicitly', () => {
    const budget = new PendingTerminalHandleRecoveryBudget()
    for (let attempt = 0; attempt < PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS; attempt += 1) {
      budget.take('terminal-a')
    }
    budget.reset()
    expect(budget.take('terminal-a')).toEqual({ allowed: true, parked: false })
  })
})

/**
 * STA-4256: the phone rendered its spinner forever because a `live` tabs stream
 * parks `poll()`, so a host that mints the handle without republishing was never
 * asked again. These drive the real controller to prove the predicate is what
 * keeps `session.tabs.list` flowing, and that it stops once the handle lands.
 */
describe('pending-handle recovery through MobileSessionTabsStreamHealth', () => {
  function makeHarness() {
    const pending: Array<(response: RpcResponse) => void> = []
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((resolve) => {
          pending.push(resolve)
        })
    )
    const client = { sendRequest, getGeneration: () => 1 } as unknown as RpcClient
    let tabs: MobileSessionTab[] = []
    let activeTabId: string | null = null
    const recoveryBudget = new PendingTerminalHandleRecoveryBudget()
    const controller = new MobileSessionTabsStreamHealth<SessionTabsResult, MobileSessionTab>({
      client,
      scope: 'id:repo::worktree',
      apply: (result): SessionTabsApplyOutcome<MobileSessionTab> => {
        tabs = result.tabs
        activeTabId = result.activeTabId
        return { accepted: true, effectiveTabs: result.tabs }
      },
      consumeAccepted: () => {},
      hasRecoveryNeed: () => hasPendingTerminalHandleRecoveryNeed(tabs, activeTabId),
      allowRecoveryPoll: () =>
        recoveryBudget.take(getPendingTerminalHandleRecoveryContextKey(tabs, activeTabId)).allowed
    })
    return {
      controller,
      sendRequest,
      resolveNext(result: SessionTabsResult) {
        const resolve = pending.shift()
        expect(resolve).toBeDefined()
        resolve?.({ id: 'list', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
      },
      readTabs: () => tabs
    }
  }

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  /** Subscribe, snapshot, updated — the sequence that certifies the stream `live`. */
  async function driveToLiveStream(
    harness: ReturnType<typeof makeHarness>,
    terminal: string | null
  ) {
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(snapshot(terminal, 'snapshot'))
    await settle()
    harness.resolveNext(snapshot(terminal))
    await settle()
    subscription.listener(snapshot(terminal, 'updated'))
    await settle()
    harness.sendRequest.mockClear()
    expect(harness.controller.isCertified()).toBe(true)
  }

  it('keeps polling session.tabs.list while the active terminal has no handle', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, null)

    expect(harness.controller.poll()).not.toBeNull()
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledWith('session.tabs.list', {
      worktree: 'id:repo::worktree'
    })
  })

  it('parks the live poll after five pending-handle lists', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, null)

    for (let attempt = 0; attempt < PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS; attempt += 1) {
      const request = harness.controller.poll()
      expect(request).not.toBeNull()
      await settle()
      harness.resolveNext(snapshot(null))
      await request
    }

    expect(harness.sendRequest).toHaveBeenCalledTimes(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS)
    expect(harness.controller.poll()).toBeNull()
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledTimes(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS)
  })

  it('does not spend live fallback attempts while a slow request is coalesced', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, null)

    for (let attempt = 0; attempt < PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS; attempt += 1) {
      const request = harness.controller.poll()
      expect(request).not.toBeNull()
      for (let joinedTick = 0; joinedTick < 5; joinedTick += 1) {
        expect(harness.controller.poll()).toBe(request)
      }
      expect(harness.sendRequest).toHaveBeenCalledTimes(attempt + 1)
      harness.resolveNext(snapshot(null))
      await request
    }

    expect(harness.controller.poll()).toBeNull()
    expect(harness.sendRequest).toHaveBeenCalledTimes(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS)
  })

  it.each(['probing', 'degraded'] as const)(
    'keeps polling a pending handle while stream health is %s',
    async (health) => {
      const harness = makeHarness()
      harness.controller.setReconciliationActive(true)
      const subscription = harness.controller.beginSubscription()
      if (health === 'degraded') {
        subscription.listener({ ...snapshot(null), type: 'end' })
      }

      for (let attempt = 0; attempt < PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 2; attempt += 1) {
        const request = harness.controller.poll()
        expect(request).not.toBeNull()
        await settle()
        harness.resolveNext(snapshot(null))
        await request
      }

      expect(harness.sendRequest).toHaveBeenCalledTimes(
        PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 2
      )
    }
  )

  it('starts a fresh retry and fences the half-open request result', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, null)

    const halfOpen = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = harness.controller.retryReconciliation()
    expect(retry).not.toBe(halfOpen)
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(harness.controller.retryReconciliation()).toBe(retry)
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)

    harness.resolveNext(snapshot('stale-handle'))
    await halfOpen
    expect(harness.readTabs()[0]).toMatchObject({ terminal: null })

    harness.resolveNext(snapshot('fresh-handle'))
    await retry
    expect(harness.readTabs()[0]).toMatchObject({ terminal: 'fresh-handle' })
  })

  it('stops polling once a fresh snapshot carries the handle', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, null)

    expect(harness.controller.poll()).not.toBeNull()
    await settle()
    harness.resolveNext(snapshot('term-1'))
    await settle()

    expect(harness.readTabs()[0]).toMatchObject({ status: 'ready', terminal: 'term-1' })
    expect(harness.controller.poll()).toBeNull()
  })

  it('parks the poll when the active terminal already has its handle', async () => {
    const harness = makeHarness()
    await driveToLiveStream(harness, 'term-1')

    expect(harness.controller.poll()).toBeNull()
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })
})
