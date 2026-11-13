import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
// Also tells TanStack observers on a microtask, so act() sees replies.
import '../test-support/query-client-test-renderer'
import { documentQueryClient } from '../test-support/rpc-recording/hook-mount'
import { useAutomationCatalog } from './use-automation-catalog'
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
