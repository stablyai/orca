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
  // Quick launch can omit launchAgent but still leak early color replies into the composer.
  const colors = { foreground: '#ffffff', background: '#282c34' }
  for (const launch of [
    { command: 'jcode', telemetry: { agent_kind: 'jcode' } },
    { telemetry: { agent_kind: 'jcode' } },
    { command: 'jcode' },
    { command: 'sleep 30 && jcode' }
  ]) {
    expect(
      getStartupTerminalIngressIntent({
        ...launch,
        terminalColorQueryReplies: colors,
        terminalKittyKeyboardProtocol: true
      })
    ).toEqual({ colors: {}, kittyKeyboardProtocol: true, deadlineMs: 5000 })
  }
  expect(
    getStartupTerminalIngressIntent({
      launchAgent: 'claude',
      terminalColorQueryReplies: colors
    })
  ).toEqual({ colors, deadlineMs: 5000 })
})
