import { describe, expect, it } from 'vitest'
import { getStartupTerminalIngressIntent } from './terminal-startup-color-query-replies'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress-intent'

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

describe('the first OSC 11 reply of a terminal a paired client created (#34340)', () => {
  const HOST_WINDOW = { foreground: '#000000', background: '#ffffff' }
  const CLIENT = { foreground: '#ffffff', background: '#282c34' }

  // Spawn assembly -> daemon wire (JSON + the owner's parse) -> owner reply, with the host window's theme host-wide.
  function firstBackgroundReply(launch: Parameters<typeof getStartupTerminalIngressIntent>[0]) {
    const intent = parsePtyStartupIngressIntent(
      JSON.parse(JSON.stringify(getStartupTerminalIngressIntent(launch)))
    )
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      ...(intent ? { intent } : {}),
      ownerBackend: 'posix-pty',
      resolveHostColors: () => HOST_WINDOW,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })
    ingress.accept('\x1b]11;?\x07')
    ingress.drainAndClose()
    return writes
  }

  it("answers with the launching client's background, not the host window's", () => {
    expect(
      firstBackgroundReply({
        command: 'codex',
        terminalColorQueryReplies: HOST_WINDOW,
        launcherColorQueryReplies: CLIENT
      })
    ).toEqual(['\x1b]11;rgb:2828/2c2c/3434\x1b\\'])
  })

  it('answers with the host-wide colours when no client launched it', () => {
    expect(
      firstBackgroundReply({ command: 'codex', terminalColorQueryReplies: HOST_WINDOW })
    ).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
  })

  it('leaves jcode unanswered even with launcher colours', () => {
    expect(
      getStartupTerminalIngressIntent({ launchAgent: 'jcode', launcherColorQueryReplies: CLIENT })
    ).toBeUndefined()
  })
})

it("carries the launcher's palette into the owner's intent only beside its colours", () => {
  const colors = { foreground: '#ffffff', background: '#282c34' }
  const attributes = {
    foreground: [0xff, 0xff, 0xff],
    background: [0x28, 0x2c, 0x34],
    cursor: [0xff, 0xff, 0xff],
    ansi: Array.from({ length: 256 }, () => [0, 0, 0]),
    colorSchemeMode: 'dark',
    cursorStyle: 'bar',
    cursorBlink: false
  }

  expect(
    getStartupTerminalIngressIntent({
      command: 'codex',
      terminalColorQueryReplies: colors,
      launcherColorQueryReplies: colors,
      launcherViewAttributes: attributes
    })?.launcherAttributes
  ).toEqual(attributes)
  expect(
    getStartupTerminalIngressIntent({
      command: 'codex',
      terminalColorQueryReplies: colors,
      launcherViewAttributes: attributes
    })
  ).not.toHaveProperty('launcherAttributes')
})
