import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import {
  agentEndCount,
  childIds,
  complete,
  endTurn,
  postedHookNames,
  posts,
  startAsync
} from './agent-status-subagent-event-fixtures'

const REPOST_INTERVAL_MS = AGENT_STATUS_STALE_AFTER_MS / 3

afterEach(() => {
  vi.useRealTimers()
})

// #46585: hosts treat 30 silent minutes as a finished turn, so a child-held turn must keep posting.
it('re-posts a child-held turn with its roster until the child settles', async () => {
  vi.useFakeTimers()
  const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
  await harness.callHook('agent_start')
  startAsync(harness, 'child-1', 'worker')
  await vi.advanceTimersByTimeAsync(0)
  await endTurn(harness)
  expect(agentEndCount(harness)).toBe(0)

  await vi.advanceTimersByTimeAsync(2 * REPOST_INTERVAL_MS)
  const reposts = posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
  expect(reposts.map(childIds)).toEqual([['child-1'], ['child-1']])

  complete(harness, 'child-1')
  await vi.advanceTimersByTimeAsync(0)
  expect(agentEndCount(harness)).toBe(1)
  const settled = postedHookNames(harness)
  await vi.advanceTimersByTimeAsync(2 * REPOST_INTERVAL_MS)
  expect(postedHookNames(harness)).toEqual(settled)
})

it('keeps one repost timer across a Pi reload', async () => {
  vi.useFakeTimers()
  const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
  await harness.callHook('agent_start')
  startAsync(harness, 'child-1', 'worker')
  await endTurn(harness)

  await vi.advanceTimersByTimeAsync(REPOST_INTERVAL_MS / 2)
  await harness.reloadPi()
  await harness.callHook('session_start', { reason: 'reload' })
  await vi.advanceTimersByTimeAsync(REPOST_INTERVAL_MS)
  const reposts = posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
  expect(reposts.map(childIds)).toEqual([['child-1']])
})

// A child that never reports again must not keep the pane working forever.
it('stops re-posting after a day without child lifecycle events', async () => {
  vi.useFakeTimers()
  const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
  await harness.callHook('agent_start')
  startAsync(harness, 'child-1', 'worker')
  await endTurn(harness)

  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  const capped = posts(harness).length
  const reposts = posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
  expect(reposts).toHaveLength(143)
  await vi.advanceTimersByTimeAsync(2 * REPOST_INTERVAL_MS)
  expect(posts(harness)).toHaveLength(capped)
  expect(agentEndCount(harness)).toBe(0)
})
