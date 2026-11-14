import { describe, expect, it } from 'vitest'
import { getStartupTerminalIngressIntent } from './terminal-startup-color-query-replies'
import { PtyStartupIngress } from '../../shared/terminal/pty/ingress/pty-startup-ingress'
import { parsePtyStartupIngressIntent } from '../../shared/terminal/pty/ingress/pty-startup-ingress-intent'

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
})
