import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeTerminalMailBridge } from './claude-terminal-mail-bridge'

const pane = {
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  sessionId: 's1',
  instanceId: 'i1'
}

describe('Claude terminal mail bridge', () => {
  afterEach(() => vi.useRealTimers())

  it('hands a submission to the polling plugin and settles it on its ack', async () => {
    const bridge = new ClaudeTerminalMailBridge()
    bridge.receive({ ...pane, action: 'poll' })
    const outcome = bridge.submit(pane.paneKey, 'You have 1 orchestration message.')

    const { submissions } = bridge.receive({ ...pane, action: 'poll' })
    expect(submissions).toEqual([
      { id: expect.any(String), text: 'You have 1 orchestration message.' }
    ])
    expect(bridge.receive({ ...pane, action: 'poll' }).submissions).toEqual([])
    bridge.receive({ ...pane, action: 'ack', id: submissions?.[0]?.id, submitted: true })
    await expect(outcome).resolves.toBe('submitted')
  })

  it('refuses a pane whose plugin is not polling, so delivery can take another way', async () => {
    vi.useFakeTimers()
    const bridge = new ClaudeTerminalMailBridge()
    await expect(bridge.submit(pane.paneKey, 'x')).resolves.toBe('refused')
    bridge.receive({ ...pane, action: 'poll' })
    vi.advanceTimersByTime(6000)
    expect(bridge.isLive(pane.paneKey)).toBe(false)
  })

  it('reports a taken submission as unverifiable when its Claude session goes away', async () => {
    const bridge = new ClaudeTerminalMailBridge()
    bridge.receive({ ...pane, action: 'poll' })
    const taken = bridge.submit(pane.paneKey, 'polled')
    bridge.receive({ ...pane, action: 'poll' })
    const untaken = bridge.submit(pane.paneKey, 'after the poll')
    bridge.receive({ ...pane, sessionId: 's2', action: 'poll' })

    await expect(taken).resolves.toBe('unverifiable')
    await expect(untaken).resolves.toBe('refused')
  })
})
