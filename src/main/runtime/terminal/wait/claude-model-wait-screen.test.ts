import { expect, it } from 'vitest'
import { claudeCompactingOnScreen, claudeTurnDoneOnScreen } from './claude-model-wait-screen'

const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'

// Drawn by Claude 2.1.330 on a worker whose turn had ended while a background shell ran on; a
// subagent hook then reopened model time, and the screen check sent a false waiting notice.
it('reads a turn Claude shows as done, with a shell still running, as waiting on nothing', () => {
  const screen = [
    '⏺ Both PR branches are updated locally. Waiting for the fixed-build 50-pane run.',
    '✻ Cooked for 8m 52s · done 1:31 AM · 1 shell still running',
    '❯',
    FOOTER
  ]
  expect(claudeTurnDoneOnScreen(screen)).toBe(true)
})

it('reads a stalled request, and a reply that says done, as still waiting', () => {
  expect(
    claudeTurnDoneOnScreen([
      '⏺ The build is done · tests next.',
      '✻ Waiting for API response · will retry in 3m 32s · check your network',
      '❯',
      FOOTER
    ])
  ).toBe(false)
  expect(claudeTurnDoneOnScreen(['· Whirlpooling… (11m 27s)', '❯', FOOTER])).toBe(false)
})

// A compaction's request writes no api-request row, so only its spinner says one is out.
it('reads a compaction in progress from its spinner', () => {
  expect(claudeCompactingOnScreen(['✻ Compacting conversation… (1m 34s)', '❯', FOOTER])).toBe(true)
  expect(claudeCompactingOnScreen(['· Whirlpooling… (11m 27s)', '❯', FOOTER])).toBe(false)
})
