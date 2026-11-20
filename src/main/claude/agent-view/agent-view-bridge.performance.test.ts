import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'

// #44987: idle agent-view sessions must not publish unchanged snapshots or wake main per session.
const keybindings =
  '{"bindings":[{"context":"Chat","bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}'
const registerFor = (index: number) => ({
  paneKey: `tab:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  sessionId: `session-${index}`,
  instanceId: `instance-${index}`,
  action: 'register',
  view: { agentId: 'child', revision: 1 },
  keybindings
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('renews without publishing and re-arms after a renewed deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const bridge = new ClaudeAgentViewBridge()
  const frames: unknown[] = []
  bridge.subscribe((snapshot) => frames.push(snapshot))
  const first = registerFor(1)
  bridge.receive(first)
  await vi.advanceTimersByTimeAsync(10_000)
  bridge.receive(registerFor(2))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(bridge.receive({ ...first, action: 'renew' })).toEqual({ registered: true })
  expect(frames).toHaveLength(3)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersToNextTimerAsync()
  expect(Date.now()).toBe(155_000)
  expect(frames).toHaveLength(3)
  await vi.advanceTimersToNextTimerAsync()
  expect(Date.now()).toBe(165_000)
  expect(frames.at(-1)).toEqual([
    { paneKey: first.paneKey, sessionId: 'session-1', agentId: 'child' }
  ])
  await vi.advanceTimersToNextTimerAsync()
  expect(Date.now()).toBe(185_000)
  expect(frames.at(-1)).toEqual([])
  expect(frames).toHaveLength(5)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([100, 1_000])(
  'publishes nothing for %i unchanged legacy registrations and once when they expire together',
  async (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const bridge = new ClaudeAgentViewBridge()
    const frames: unknown[] = []
    bridge.subscribe((snapshot) => frames.push(snapshot))
    for (let index = 0; index < count; index++) {
      bridge.receive(registerFor(index))
      await vi.advanceTimersByTimeAsync(1)
    }
    const settled = frames.length
    // Staggered renewals leave staggered deadlines; batching must still expire them in one pass.
    for (let index = 0; index < count; index++) {
      bridge.receive(registerFor(index))
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(frames).toHaveLength(settled)
    await vi.advanceTimersByTimeAsync(160_000)
    expect(frames).toHaveLength(settled + 1)
    expect(frames.at(-1)).toEqual([])
  }
)
