import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
// Also tells TanStack observers on a microtask, so act() sees replies.
import '../test-support/query-client-test-renderer'
import { documentQueryClient } from '../test-support/rpc-recording/hook-mount'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { restoreAutomationCatalog, useAutomationCatalog } from './use-automation-catalog'
import { automationClient, deferred, savedAutomation } from './automation-test-fixtures'

let tree: ReactTestRenderer | null = null
let document = documentQueryClient()
afterEach(async () => {
  act(() => tree?.unmount())
  tree = null
  await document.end()
  document = documentQueryClient()
})

const local = { ...savedAutomation(), id: 'local-1', name: 'Local review' }
const remote = { ...savedAutomation(), id: 'ssh-1', name: 'Box review' }
function listReply(remoteName: string) {
  return {
    automations: [local, { ...remote, name: remoteName }],
    items: [
      { automationId: local.id, selector: { kind: 'self' } },
      { automationId: remote.id, selector: { kind: 'ssh', targetId: 'box', targetGeneration: 1 } }
    ]
  }
}

function catalogHarness(respond: () => unknown) {
  const port = automationClient((method) =>
    method === 'status.get' ? { capabilities: [] } : respond()
  )
  let state: ReturnType<typeof useAutomationCatalog> | null = null
  function Probe() {
    state = useAutomationCatalog('desktop', port.client)
    return null
  }
  const read = () => {
    if (!state) {
      throw new Error('Not mounted')
    }
    return state
  }
  const mount = async () => {
    await act(async () => {
      tree = create(document.wrap(createElement(Probe)))
    })
  }
  return { port, read, mount }
}

describe('automation catalog', () => {
  it('opens a restored desktop list offline and replaces it with the live list on reconnect', async () => {
    const queryClient = createOrcaQueryClient()
    const port = automationClient((method) =>
      method === 'status.get' ? { capabilities: [] } : listReply('Box nightly')
    )
    const saved = { result: listReply('Box review'), readAt: 1_000 }
    port.state('disconnected')
    restoreAutomationCatalog(queryClient, 'desktop', saved)
    const states: ReturnType<typeof useAutomationCatalog>[] = []
    function Probe() {
      states.push(useAutomationCatalog('desktop', port.client))
      return null
    }
    try {
      await act(async () => {
        tree = create(
          createElement(QueryClientProvider, { client: queryClient }, createElement(Probe))
        )
      })
      expect(states[0]?.rows.map((row) => row.automation.name)).toEqual([
        'Local review',
        'Box review'
      ])
      expect(states.at(-1)?.connected).toBe(false)

      await act(async () => port.state('connected'))
      restoreAutomationCatalog(queryClient, 'desktop', saved)
      expect(states.at(-1)?.rows.map((row) => row.automation.name)).toEqual([
        'Local review',
        'Box nightly'
      ])
    } finally {
      act(() => tree?.unmount())
      tree = null
      queryClient.clear()
    }
  })

  it('shows the last list at once when the screen reopens, then the host’s newer one', async () => {
    let reply: ReturnType<typeof deferred<unknown>> | null = null
    const { read, mount } = catalogHarness(() => reply?.promise ?? listReply('Box review'))
    await mount()
    expect(read().rows.map((row) => row.automation.name)).toEqual(['Local review', 'Box review'])
    act(() => tree?.unmount())
    reply = deferred<unknown>()
    await mount()
    expect(read().loaded).toBe(true)
    expect(read().rows.map((row) => row.automation.name)).toEqual(['Local review', 'Box review'])
    await act(async () => reply?.resolve(listReply('Box nightly')))
    expect(read().rows.map((row) => row.automation.name)).toEqual(['Local review', 'Box nightly'])
  })

  it('keeps a saved change when a list read sent before the write lands after it', async () => {
    let held: ReturnType<typeof deferred<unknown>> | null = null
    let remoteName = 'Box review'
    const { read, mount } = catalogHarness(() => held?.promise ?? listReply(remoteName))
    await mount()
    const early = deferred<unknown>()
    held = early
    await act(async () => void read().refresh())
    held = null
    remoteName = 'Box renamed'
    await act(async () =>
      read().perform(
        async () => 'Box renamed',
        (name) =>
          read().setRows((rows) =>
            rows.map((row) =>
              row.automation.id === remote.id
                ? { ...row, automation: { ...row.automation, name } }
                : row
            )
          )
      )
    )
    await act(async () => early.resolve(listReply('Box review')))
    expect(read().rows[1]?.automation.name).toBe('Box renamed')
  })

  it('updates an SSH target’s automation on its change event and leaves the local one as it was', async () => {
    let remoteName = 'Box review'
    const { port, read, mount } = catalogHarness(() => listReply(remoteName))
    await mount()
    await act(async () => port.event({ type: 'ready', subscriptionId: 'events' }))
    const before = read().rows[0]
    remoteName = 'Box nightly'
    await act(async () =>
      port.event({ type: 'automationsChanged', selector: { kind: 'ssh', targetId: 'box' } })
    )
    expect(read().rows[1]?.automation.name).toBe('Box nightly')
    expect(read().rows[0]).toBe(before)
  })
})
