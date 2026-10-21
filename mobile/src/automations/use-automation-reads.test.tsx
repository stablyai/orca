import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutomationCatalog } from './use-automation-catalog'
import { useAutomationRuns } from './use-automation-runs'
import { automationClient, deferred, savedAutomation, savedRun } from './automation-test-fixtures'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})
function latest<T>(read: () => T | null) {
  const value = read()
  if (!value) {
    throw new Error('Not mounted')
  }
  return value
}

describe('host-owned automation reads', () => {
  it('keeps loaded pages offline and queues invalidation during a history request', async () => {
    const pending = deferred<unknown>()
    let page = 0
    const port = automationClient(() => {
      page++
      if (page === 1) {
        return { runs: [savedRun('new')], nextCursor: 'older' }
      }
      if (page === 2) {
        return pending.promise
      }
      return { runs: [{ ...savedRun('new'), status: 'completed' }], nextCursor: 'older' }
    })
    let state: ReturnType<typeof useAutomationRuns> | null = null
    function Probe({ revision, connected }: { revision: number; connected: boolean }) {
      state = useAutomationRuns(port.client, null, revision, connected)
      return null
    }
    const read = () => latest(() => state)
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0, connected: true }))
    })
    await act(async () => {
      read().loadMore()
    })
    await act(async () => {
      tree?.update(createElement(Probe, { revision: 1, connected: true }))
    })
    await act(async () => {
      pending.resolve({ runs: [savedRun('old')], nextCursor: 'oldest' })
    })
    expect(read().runs.map((run) => run.id)).toEqual(['new', 'old'])
    expect(read().cursor).toBe('oldest')
    expect(port.send).toHaveBeenCalledTimes(3)
    await act(async () => {
      port.state('disconnected')
      tree?.update(createElement(Probe, { revision: 1, connected: false }))
    })
    expect(read().runs.map((run) => run.id)).toEqual(['new', 'old'])
    expect(read().loading).toBe(false)
  })
  it('ignores a previous connection snapshot and keeps delivery ambiguity until explicit refresh', async () => {
    const pending = deferred<unknown>()
    let listReads = 0
    const automation = savedAutomation()
    const catalogReply = {
      automations: [automation],
      items: [{ automationId: automation.id, selector: { kind: 'self' } }]
    }
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      return ++listReads === 1 ? pending.promise : catalogReply
    })
    let state: ReturnType<typeof useAutomationCatalog> | null = null
    function Probe() {
      state = useAutomationCatalog(port.client, false)
      return null
    }
    const read = () => latest(() => state)
    await act(async () => {
      tree = create(createElement(Probe))
    })
    await act(async () => {
      port.state('disconnected')
      port.state('connected')
    })
    await act(async () => {
      pending.resolve({ automations: [], items: [] })
    })
    expect(read().rows.map((row) => row.automation.id)).toEqual(['automation-1'])
    let attempts = 0
    await act(async () => {
      await read().perform(
        async () => {
          attempts++
          throw markRpcDeliveryUnknown(new Error('Connection lost'))
        },
        () => {}
      )
    })
    expect(attempts).toBe(1)
    expect(read().error).toContain('may have applied')
    await act(async () => {
      port.event({ type: 'automationsChanged' })
    })
    expect(read().error).toContain('may have applied')
    await act(async () => {
      await read().refresh(true)
    })
    expect(read().error).toBeNull()
  })
})
