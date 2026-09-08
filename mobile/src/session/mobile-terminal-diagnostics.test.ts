import { describe, expect, it, vi } from 'vitest'
import {
  logMobileTerminalDiagnostic,
  MobileTerminalDiagnostics
} from './mobile-terminal-diagnostics'

describe('mobile terminal diagnostics', () => {
  it('uses one filterable structured log tag', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    logMobileTerminalDiagnostic('stream-armed', { seq: 2 })

    expect(log).toHaveBeenCalledWith('[terminal-diagnostic]', 'stream-armed', {
      seq: 2
    })
    log.mockRestore()
  })

  it('does not expose runtime identities or host-provided strings', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()
    const secret = 'credential-secret-/private/worktree'
    const tab = { id: secret, type: secret, isActive: true, terminal: secret }

    diagnostics.streamSkipped(secret, secret, true)
    diagnostics.streamScrollback(secret, 1, 2, {
      cols: 80,
      rows: 24,
      serialized: secret,
      displayMode: secret,
      source: secret
    })
    diagnostics.tabsFetchStarted(secret)
    diagnostics.tabsFetchFailed(secret)
    diagnostics.tabsFetchErrored(Object.assign(new Error(secret), { name: secret }))
    diagnostics.tabsApplied(
      { publicationEpoch: secret, snapshotVersion: 1, tabs: [tab] },
      [tab],
      tab,
      secret
    )
    diagnostics.tabSwitch(secret, secret, false, secret)

    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    log.mockRestore()
  })

  it('forgets first-event state when a terminal unsubscribes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')
    diagnostics.terminalUnsubscribed('terminal-1')
    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')

    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('records binary snapshot sizes without recording snapshot content', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.streamScrollback('terminal-1', 1, 2, {
      serialized: new Uint8Array([1, 2, 3]),
      oscLinks: [{ uri: 'credential-secret' }]
    })

    expect(log).toHaveBeenCalledWith('[terminal-diagnostic]', 'stream-scrollback', {
      seq: 1,
      eventSeq: 2,
      cols: null,
      rows: null,
      serializedLength: 3,
      oscLinkCount: 1,
      scrollbackRows: null,
      truncated: false
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('credential-secret')
    log.mockRestore()
  })
})
