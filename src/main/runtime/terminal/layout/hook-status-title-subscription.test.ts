import { describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../../../agent-hooks/server/server-types'
import { subscribeHookStatusTitles } from './hook-status-title-subscription'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

function hookServer() {
  const listeners: ((row: EnrichedAgentHookEventPayload) => void)[] = []
  return {
    listeners,
    subscribeEnrichedStatus: vi.fn((listener: (row: EnrichedAgentHookEventPayload) => void) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    })
  }
}

describe('main’s generated titles from hook status', () => {
  it('follows every status in a layout-owner build, until unsubscribed', () => {
    layoutOwner.isMain = true
    const server = hookServer()
    const runtime = { recordHookStatusTitle: vi.fn() }

    const unsubscribe = subscribeHookStatusTitles(server, runtime)
    expect(server.listeners).toHaveLength(1)
    unsubscribe()

    expect(server.listeners).toHaveLength(0)
  })

  it('subscribes to nothing with the switch off, where the window titles its tabs', () => {
    layoutOwner.isMain = false
    const server = hookServer()

    subscribeHookStatusTitles(server, { recordHookStatusTitle: vi.fn() })

    expect(server.subscribeEnrichedStatus).not.toHaveBeenCalled()
  })
})
