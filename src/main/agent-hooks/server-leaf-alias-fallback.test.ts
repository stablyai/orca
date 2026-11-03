import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildBody, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const SOURCE = makePaneKey('tab-source', LEAF)
const TARGET = makePaneKey('tab-target', LEAF)

let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  // The source tab closed after the pane moved, and the in-memory alias is gone.
  server.dropStatusEntriesByTabPrefix('tab-source')
})

afterEach(() => {
  server.stop()
})

async function postFromSource(prompt: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'UserPromptSubmit', prompt },
      { paneKey: SOURCE, tabId: 'tab-source' }
    )
  )
  expect(response.status).toBe(204)
}

describe('leaf-id fallback for an evicted or unwritten pane alias', () => {
  it('routes the closed source key to the one live tab that holds the leaf', async () => {
    const lookups: [string, string][] = []
    server.setLiveLeafOwnerResolver((tabId, leafId) => {
      lookups.push([tabId, leafId])
      return 'tab-target'
    })

    await postFromSource('after eviction')

    expect(lookups).toEqual([['tab-source', LEAF]])
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, prompt: 'after eviction' })
    ])
  })

  it('registers the alias so later events skip the lookup', async () => {
    const resolver = vi.fn(() => 'tab-target')
    server.setLiveLeafOwnerResolver(resolver)

    await postFromSource('first')
    await postFromSource('second')

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, prompt: 'second' })
    ])
  })

  it('leaves a closed tab suppressed when no live tab holds the leaf', async () => {
    server.setLiveLeafOwnerResolver(() => null)

    await postFromSource('nobody owns this')

    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('routes an SSH relay event from the closed source key the same way', () => {
    server.setLiveLeafOwnerResolver(() => 'tab-target')

    server.ingestRemote(
      {
        paneKey: SOURCE,
        tabId: 'tab-source',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'relay after eviction' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, prompt: 'relay after eviction' })
    ])
  })

  it('does not scan layouts for an open tab that already has a status row', async () => {
    const resolver = vi.fn(() => null)
    server.setLiveLeafOwnerResolver(resolver)
    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'first' }
    })

    const response = await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'second' },
        { paneKey: TARGET, tabId: 'tab-target' }
      )
    )

    expect(response.status).toBe(204)
    expect(resolver).not.toHaveBeenCalled()
  })
})
