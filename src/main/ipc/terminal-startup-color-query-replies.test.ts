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
