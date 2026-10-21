import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const hook = {
  paneKey: PANE,
  source: 'omp',
  hookEventName: 'before_agent_start',
  payload: { agentType: 'omp', state: 'working', prompt: 'new turn' }
}

describe('OMP retirement acknowledgement', () => {
  it('emits a single live acknowledgement and never trusts one in hook input', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    server.retirePaneAuthority(PANE, ID)
    server.ingestRemote(JSON.parse(JSON.stringify({ ...hook, authorityRestartId: 'forged' })), null)
    expect(listener.mock.calls[0][0].authorityRestartId).toBe(ID)
    server.ingestRemote(hook, null)
    expect(listener.mock.calls[1][0]).not.toHaveProperty('authorityRestartId')
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('authorityRestartId')
    server.stop()
  })

  it.each(['attach', 'replacement', 'close'])('revokes recovery after %s', (operation) => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    server.retirePaneAuthority(PANE, ID)
    if (operation === 'attach') {
      server.restorePaneAuthority(PANE)
    }
    if (operation === 'replacement') {
      server.retirePaneAuthority(PANE)
    }
    if (operation === 'close') {
      server.dropStatusEntriesByTabPrefix('tab-1')
      // Evict the tab LRU while retaining the pane fence.
      for (let n = 0; n < 1025; n++) {
        server.dropStatusEntriesByTabPrefix(`other-${n}`)
      }
    }
    if (operation === 'close') {
      server.retirePaneAuthority(PANE, ID)
    }
    server.ingestRemote(hook, null)
    for (const [event] of listener.mock.calls) {
      expect(event).not.toHaveProperty('authorityRestartId')
    }
    server.stop()
  })
})

it.each([false, true])('keeps repeated detached retirement coherent (closed=%s)', (closed) => {
  const server = new AgentHookServer()
  const listener = vi.fn()
  const ownerPane = 'owner:22222222-2222-4222-8222-222222222222'
  const latestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  server.setListener(listener)
  try {
    server.transferPaneAuthority(PANE, ownerPane, 'pty')
    server.retirePaneAuthority(ownerPane, ID)
    server.retirePaneAuthority(ownerPane, latestId)
    if (closed) {
      server.dropStatusEntriesByTabPrefix('owner')
      for (let n = 0; n < 1025; n++) {
        server.dropStatusEntriesByTabPrefix(`other-${n}`)
      }
    }
    server.ingestRemote(hook, null)
    server.ingestRemote(hook, null)
    if (closed) {
      expect(server.getStatusSnapshot()).toEqual([])
      expect(listener).not.toHaveBeenCalled()
    } else {
      expect(listener.mock.calls[0][0]).toMatchObject({
        paneKey: ownerPane,
        authorityRestartId: latestId
      })
      expect(listener.mock.calls[1][0]).not.toHaveProperty('authorityRestartId')
    }
  } finally {
    server.stop()
  }
})
