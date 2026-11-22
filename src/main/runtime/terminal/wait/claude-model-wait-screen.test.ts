import { describe, expect, it } from 'vitest'
import {
  claudeModelWaitLastSeen,
  claudeReplyScreen,
  claudeToolRunsOnScreen
} from './claude-model-wait-screen'

// Lines as Claude 2.1.330 drew them in a worker pane (rig, 2026-11-21).
const chrome = (status: string) => [
  '────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────',
  status,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'
]

describe("terminal Claude's screen while it waits on the model", () => {
  it('reads a stalled request as unchanged though its spinner moves', () => {
    const before = [
      '⏺ Reply PONG',
      ...chrome('✻ Waiting for API response · will retry in 3m 38s · check your network')
    ]
    const after = ['⏺ Reply PONG', ...chrome('✶ Calculating… (5m 25s)')]
    expect(claudeReplyScreen(before)).toBe(claudeReplyScreen(after))
    expect(claudeModelWaitLastSeen(before)).toBe(
      'Waiting for API response · will retry in 3m 38s · check your network'
    )
  })

  it('reads a streaming reply as changed', () => {
    const before = ['⏺ 1. Lake Baikal is the deepest lake.', ...chrome('✳ Kneading… (40s)')]
    const after = [
      '⏺ 1. Lake Baikal is the deepest lake.',
      '  2. Lake Superior holds a tenth of the fresh surface water.',
      ...chrome('✳ Kneading… (44s)')
    ]
    expect(claudeReplyScreen(before)).not.toBe(claudeReplyScreen(after))
  })

  it("reads a tool call's input streaming, which Claude does not draw, by its received tokens", () => {
    const tip = '  ⎿  Tip: Use /btw to ask a side question without interrupting Claude'
    const before = ['  60.', ...chrome('· Zigzagging… (10m 8s · ↓ 1.2k tokens)'), tip]
    const same = ['  60.', ...chrome('✽ Zigzagging… (10m 23s · ↓ 1.2k tokens)'), tip]
    const after = ['  60.', ...chrome('✢ Zigzagging… (10m 38s · ↓ 1.4k tokens)'), tip]
    expect(claudeReplyScreen(before)).toBe(claudeReplyScreen(same))
    expect(claudeReplyScreen(before)).not.toBe(claudeReplyScreen(after))
  })

  it("reads a running tool's ticking timer as unchanged, and as a running tool", () => {
    const before = [
      '⏺ Bash(python3 longjob.py)',
      '  ⎿  Running… (3s · timeout 20m)',
      ...chrome('✳ Smooshing… (7s · ↓ 135 tokens)')
    ]
    const after = [
      '⏺ Bash(python3 longjob.py)',
      '  ⎿  Running… (7s · timeout 20m)',
      ...chrome('✳ Smooshing… (11s · ↓ 135 tokens)')
    ]
    expect(claudeReplyScreen(before)).toBe(claudeReplyScreen(after))
    expect(claudeToolRunsOnScreen(after)).toBe(true)
    expect(claudeToolRunsOnScreen(chrome('✶ Calculating… (5m 25s)'))).toBe(false)
  })

  it("names Claude's retry, else its spinner, else the last line it drew", () => {
    expect(claudeModelWaitLastSeen(chrome('✻ API error · retrying… · attempt 1/8'))).toBe(
      'API error · retrying… · attempt 1/8'
    )
    expect(
      claudeModelWaitLastSeen(['⏺ Thinking about the plan', ...chrome('✶ Calculating… (10m 2s)')])
    ).toBe('Calculating… (10m 2s)')
    expect(claudeModelWaitLastSeen(['⏺ Thinking about the plan', ...chrome('')])).toBe(
      '⏺ Thinking about the plan'
    )
  })
})
