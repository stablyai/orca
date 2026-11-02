// Runs on plain Node, as orcad does: the feed reads the runtime's own producers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../orca-runtime'
import { requireSwitchedOn } from './require-switched-on'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the runtime sidebar inputs feed', () => {
  it('publishes the producers’ snapshots and announces a change on the client-event bus', async () => {
    const runtime = new OrcaRuntimeService(null)
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(phone.view().temporal).toEqual({ sessionId: null, sortSnapshot: null, retention: null })

    const creation = requireSwitchedOn(runtime.workspaceCreations).open({
      creationId: 'c1',
      repoId: 'repo-1'
    })
    await vi.advanceTimersByTimeAsync(60)
    const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
    expect(notice).toEqual({
      type: 'sidebarInputsChanged',
      generation: feed.generation,
      revision: expect.any(Number)
    })
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('no change notice')
    }
    phone.notice(notice)
    await phone.settle()
    expect(phone.replies.at(-1)).toMatchObject({
      kind: 'delta',
      domains: { creations: { upserts: { c1: { repoId: 'repo-1' } } } }
    })
    creation.close()
    phone.disconnect()
  })
})
