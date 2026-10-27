import { describe, expect, it } from 'vitest'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import { mainPaneVerdict } from './main-pane-verdict'

const LIVE_PTY = { connected: true, lastExitCode: null } as const

function host(opts: {
  registered?: boolean
  verdict?: PtyLivenessVerdict
  inventory?: string[] | null
}): Parameters<typeof mainPaneVerdict>[1] {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: paneTerminalFact reads only connected and lastExitCode.
    ptysById: new Map(opts.registered ? [['pty-a', LIVE_PTY as never]] : []),
    livenessOf: () => opts.verdict ?? null,
    inventoryLivePtyIds:
      opts.inventory === undefined ? null : opts.inventory && new Set(opts.inventory),
    controllerHasPty: () => false
  }
}

describe('a main-owned pane verdict', () => {
  it('a pane with no status is live only on the host word', () => {
    const pane = { ptyId: 'pty-a', hasStatus: false, starting: false }
    expect(mainPaneVerdict(pane, host({ registered: true, inventory: ['pty-a'] }))).toBe('live')
    expect(
      mainPaneVerdict(
        pane,
        host({ registered: true, verdict: { status: 'unverifiable', reason: 'lost contact' } })
      )
    ).toBe('unverifiable')
  })

  it.each(['live', 'unverifiable'] as const)(
    'a pane with a status is never live (host says %s)',
    (status) => {
      const verdict: PtyLivenessVerdict =
        status === 'live'
          ? { status: 'live', ptyIds: ['pty-a'] }
          : { status: 'unverifiable', reason: 'lost contact' }
      expect(
        mainPaneVerdict(
          { ptyId: 'pty-a', hasStatus: true, starting: false },
          host({ registered: true, verdict })
        )
      ).toBe('unverifiable')
    }
  )

  it('a sleeping pane whose terminal the host reports absent is exited', () => {
    expect(
      mainPaneVerdict({ ptyId: 'pty-a', hasStatus: true, starting: false }, host({ inventory: [] }))
    ).toBe('exited')
  })

  it('a sleeping pane on an unreachable host is unverifiable, never exited', () => {
    expect(mainPaneVerdict({ ptyId: 'pty-a', hasStatus: true, starting: false }, host({}))).toBe(
      'unverifiable'
    )
    // The local inventory cannot speak for an SSH terminal.
    expect(
      mainPaneVerdict(
        { ptyId: 'ssh:conn-1@@pty-a', hasStatus: true, starting: false },
        host({ inventory: [] })
      )
    ).toBe('unverifiable')
  })

  // A remote terminal's verdict is its own host's answer, through the relay or the server's list.
  it.each<[PtyLivenessVerdict, PtyLivenessVerdict['status']]>([
    [{ status: 'exited' }, 'exited'],
    [{ status: 'unverifiable', reason: 'relay timed out' }, 'unverifiable'],
    [{ status: 'live', ptyIds: ['ssh:conn-1@@pty-a'] }, 'live']
  ])('a remote host answer %o reads %s', (verdict, expected) => {
    expect(
      mainPaneVerdict(
        { ptyId: 'ssh:conn-1@@pty-a', hasStatus: false, starting: false },
        host({ verdict, inventory: [] })
      )
    ).toBe(expected)
  })

  it('a starting pane is unverifiable, whatever its old binding did', () => {
    for (const ptyId of [null, 'pty-a']) {
      expect(
        mainPaneVerdict({ ptyId, hasStatus: true, starting: true }, host({ inventory: [] }))
      ).toBe('unverifiable')
    }
  })

  it('an unbound pane is exited only once the host answered', () => {
    const pane = { ptyId: null, hasStatus: false, starting: false }
    expect(mainPaneVerdict(pane, host({ inventory: [] }))).toBe('exited')
    expect(mainPaneVerdict(pane, host({}))).toBe('unverifiable')
  })
})
