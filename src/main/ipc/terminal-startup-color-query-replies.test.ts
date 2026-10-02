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
it('keeps Kitty startup support to agent launches', () => {
  expect(
    getStartupTerminalIngressIntent({ command: 'echo hello', terminalKittyKeyboardProtocol: true })
  ).toBeUndefined()
  expect(getStartupTerminalIngressIntent({ launchAgent: 'omp' })).toBeUndefined()
})
it('seeds the creating viewer colours for every PTY, not only agent launches', () => {
  const colors = { foreground: '#fff', background: '#000' }
  expect(
    getStartupTerminalIngressIntent({ launchAgent: 'omp', terminalColorQueryReplies: colors })
  ).toEqual({ colors, deadlineMs: 5000 })
  expect(
    getStartupTerminalIngressIntent({
      command: 'echo hello',
      terminalColorQueryReplies: colors,
      terminalKittyKeyboardProtocol: true
    })
  ).toEqual({ colors, deadlineMs: 5000 })
  expect(
    getStartupTerminalIngressIntent({
      terminalColorQueryReplies: { foreground: '#fff', background: 'not-a-color' }
    })
  ).toBeUndefined()
})
