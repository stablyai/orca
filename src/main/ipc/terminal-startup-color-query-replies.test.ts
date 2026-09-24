import { expect, it } from 'vitest'
import { getStartupTerminalIngressIntent } from './terminal-startup-color-query-replies'

it.each([{ launchAgent: 'omp' }, { command: 'omp' }, { telemetry: { agent_kind: 'omp' } }])(
  'keeps keyboard startup support without theme colors: %j',
  (launch) => {
    expect(
      getStartupTerminalIngressIntent({ ...launch, terminalKittyKeyboardProtocol: true })
    ).toEqual({
      colors: {},
      kittyKeyboardProtocol: true,
      deadlineMs: 5000
    })
  }
)
it('leaves ordinary shells and unadvertised keyboard support alone', () => {
  expect(
    getStartupTerminalIngressIntent({ command: 'echo hello', terminalKittyKeyboardProtocol: true })
  ).toBeUndefined()
  expect(getStartupTerminalIngressIntent({ launchAgent: 'omp' })).toBeUndefined()
})
it('preserves color-only startup on renderers without Kitty support', () => {
  const colors = { foreground: '#fff', background: '#000' }
  expect(
    getStartupTerminalIngressIntent({ launchAgent: 'omp', terminalColorQueryReplies: colors })
  ).toEqual({ colors, deadlineMs: 5000 })
})

it('does not answer jcode startup color queries but keeps keyboard support', () => {
  const colors = { foreground: '#ffffff', background: '#282c34' }
  expect(
    getStartupTerminalIngressIntent({
      launchAgent: 'jcode',
      terminalColorQueryReplies: colors,
      terminalKittyKeyboardProtocol: true
    })
  ).toEqual({ colors: {}, kittyKeyboardProtocol: true, deadlineMs: 5000 })
  expect(
    getStartupTerminalIngressIntent({ launchAgent: 'jcode', terminalColorQueryReplies: colors })
  ).toBeUndefined()
})

it('skips jcode startup colors when only the command or telemetry names it', () => {
  // Why: a quick-launch pane carries no launchAgent, and it leaks the same
  // composer text the launchAgent-based skip was added to prevent.
  const colors = { foreground: '#ffffff', background: '#282c34' }
  for (const launch of [
    { command: 'jcode', telemetry: { agent_kind: 'jcode' } },
    { telemetry: { agent_kind: 'jcode' } },
    { command: 'jcode' }
  ]) {
    expect(
      getStartupTerminalIngressIntent({
        ...launch,
        terminalColorQueryReplies: colors,
        terminalKittyKeyboardProtocol: true
      })
    ).toEqual({ colors: {}, kittyKeyboardProtocol: true, deadlineMs: 5000 })
  }
  // A different agent still gets its colors.
  expect(
    getStartupTerminalIngressIntent({
      launchAgent: 'claude',
      terminalColorQueryReplies: colors
    })
  ).toEqual({ colors, deadlineMs: 5000 })
})
