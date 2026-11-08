import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse } from '../../transport/types'
import type { MobileSessionTab, SessionTabsResult } from '../../session/mobile-session-route-types'
import {
  getPendingTerminalHandleRecoveryContextKey,
  hasPendingTerminalHandleRecoveryNeed,
  PendingTerminalHandleRecoveryBudget
} from './pending-terminal-handle-recovery'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome
} from '../../session/tabs/mobile-session-tabs-stream-health'

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

// Keep polling a live tabs stream while a selected tab lacks its handle; hosts can mint the PTY without republishing.
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
