// STA-2864, fourth defect: status delivery used to run through one replaceable listener slot
// (`setListener`) that only the desktop window ever installed. A host that never opens a window
// therefore had no status-event subscriber at all, and a second consumer could only take
// delivery by evicting the first.
//
// These pin the subscription that replaced it: more than one consumer, a consumer on a
// windowless host, and a subscription that can end.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { GOOD_PANE, PANE } from './server.test-fixtures'
import { parsePaneKey } from '../../shared/stable-pane-id'

beforeEach(() => {
  _internals.resetCachesForTests()
})

function observeWorking(server: AgentHookServer, paneKey: string, prompt: string): void {
  server.ingestRemote(
    {
      paneKey,
      tabId: parsePaneKey(paneKey)?.tabId,
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt, agentType: 'codex' }
    },
    'conn-1'
  )
}

const replayedRow = (paneKey: string, prompt: string) =>
  expect.objectContaining({
    paneKey,
    isReplay: true,
    payload: expect.objectContaining({ state: 'working', prompt })
  })

const liveRow = (paneKey: string, prompt: string) =>
  expect.objectContaining({
    paneKey,
    payload: expect.objectContaining({ state: 'working', prompt })
  })

describe('agent-status subscription', () => {
  it('replays the cached rows to every subscriber that asks, not just the first', () => {
    const server = new AgentHookServer()
    observeWorking(server, PANE, 'cached task')

    const desktop = vi.fn()
    const second = vi.fn()
    server.subscribeEnrichedStatus(desktop, { replay: true })
    server.subscribeEnrichedStatus(second, { replay: true })

    for (const subscriber of [desktop, second]) {
      expect(subscriber).toHaveBeenCalledWith(replayedRow(PANE, 'cached task'))
    }

    observeWorking(server, GOOD_PANE, 'live task')

    for (const subscriber of [desktop, second]) {
      expect(subscriber).toHaveBeenCalledWith(liveRow(GOOD_PANE, 'live task'))
    }
  })

  it('gives a host that never opens a window a subscriber on both status and clear', () => {
    // Shape of `orca serve` / orcad: nothing installs a window fan-out, and the rows the host
    // is holding were observed before this subscriber existed.
    const server = new AgentHookServer()
    observeWorking(server, PANE, 'work observed before the subscriber')

    const headlessStatus = vi.fn()
    const headlessClear = vi.fn()
    server.subscribeEnrichedStatus(headlessStatus, { replay: true })
    server.subscribePaneStatusClear(headlessClear)

    expect(headlessStatus).toHaveBeenCalledWith(
      replayedRow(PANE, 'work observed before the subscriber')
    )

    observeWorking(server, GOOD_PANE, 'live task')
    server.clearPaneState(GOOD_PANE)

    expect(headlessStatus).toHaveBeenCalledWith(liveRow(GOOD_PANE, 'live task'))
    expect(headlessClear).toHaveBeenCalledWith({ paneKey: GOOD_PANE })
  })

  it('keeps no single listener slot a window could own', () => {
    // Why assert absence: the defect was the slot's existence, not its contents. A reinstated
    // `setListener` would pass every behavioural test above while re-coupling delivery to it.
    const server = new AgentHookServer()
    expect('setListener' in server).toBe(false)
    expect('setPaneStatusClearListener' in server).toBe(false)
  })

  it('ends one subscription without disturbing the others', () => {
    const server = new AgentHookServer()
    const removed = vi.fn()
    const remaining = vi.fn()
    const removedClear = vi.fn()
    const remainingClear = vi.fn()
    const unsubscribeStatus = server.subscribeEnrichedStatus(removed, { replay: true })
    server.subscribeEnrichedStatus(remaining, { replay: true })
    const unsubscribeClear = server.subscribePaneStatusClear(removedClear)
    server.subscribePaneStatusClear(remainingClear)

    unsubscribeStatus()
    unsubscribeClear()
    observeWorking(server, PANE, 'after unsubscribe')
    server.clearPaneState(PANE)

    expect(removed).not.toHaveBeenCalled()
    expect(removedClear).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalledWith(liveRow(PANE, 'after unsubscribe'))
    expect(remainingClear).toHaveBeenCalledWith({ paneKey: PANE })
  })

  it('unsubscribing twice is harmless and removes nothing else', () => {
    const server = new AgentHookServer()
    const removed = vi.fn()
    const remaining = vi.fn()
    const unsubscribe = server.subscribeEnrichedStatus(removed)
    server.subscribeEnrichedStatus(remaining)

    unsubscribe()
    unsubscribe()
    observeWorking(server, PANE, 'after double unsubscribe')

    expect(removed).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalledWith(liveRow(PANE, 'after double unsubscribe'))
  })

  it('a throwing subscriber starves neither the replay nor the live fan-out', () => {
    const server = new AgentHookServer()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    observeWorking(server, PANE, 'cached task')

    const survivor = vi.fn()
    server.subscribeEnrichedStatus(
      () => {
        throw new Error('subscriber blew up')
      },
      { replay: true }
    )
    server.subscribeEnrichedStatus(survivor, { replay: true })

    expect(survivor).toHaveBeenCalledWith(replayedRow(PANE, 'cached task'))

    observeWorking(server, GOOD_PANE, 'live task')

    expect(survivor).toHaveBeenCalledWith(liveRow(GOOD_PANE, 'live task'))
    errors.mockRestore()
  })
})
