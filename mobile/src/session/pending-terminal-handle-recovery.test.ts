import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { hasPendingTerminalHandleRecoveryNeed } from './pending-terminal-handle-recovery'
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
    const controller = new MobileSessionTabsStreamHealth<SessionTabsResult, MobileSessionTab>({
      client,
      scope: 'id:repo::worktree',
      apply: (result): SessionTabsApplyOutcome<MobileSessionTab> => {
        tabs = result.tabs
        activeTabId = result.activeTabId
        return { accepted: true, effectiveTabs: result.tabs }
      },
      consumeAccepted: () => {},
      hasRecoveryNeed: () => hasPendingTerminalHandleRecoveryNeed(tabs, activeTabId)
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
