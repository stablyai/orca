import { describe, expect, it } from 'vitest'
import { bridgeDiagnosticLine, frameWithoutHostLine } from './shell-bridge-log-lines'

describe('shell bridge log lines', () => {
  it('skips routine bridge kinds and names the specific failure for the rest', () => {
    expect(
      bridgeDiagnosticLine({
        kind: 'terminal-backlog',
        id: 't',
        coalescedFrames: 0,
        deliveredFrames: 0,
        peakPendingBytes: 0,
        ended: null
      })
    ).toBeNull()
    expect(
      bridgeDiagnosticLine({ kind: 'notify-refused', name: 'fault', why: 'ungranted' })
    ).toEqual({
      level: 'warn',
      code: 'web-shell-bridge',
      message: 'Web shell bridge: notify-refused',
      detail: 'ungranted'
    })
    const gone = new Error('view gone')
    gone.name = 'BridgeViewGoneError'
    expect(bridgeDiagnosticLine({ kind: 'post-failed', error: gone })?.detail).toBe(
      'error=BridgeViewGoneError'
    )
    expect(bridgeDiagnosticLine({ kind: 'post-failed', error: 'nope' })?.detail).toBe(
      'error=string'
    )
    expect(
      bridgeDiagnosticLine({ kind: 'route-refused', issue: 'Invalid path /Users/bob/wt' })?.detail
    ).toBe('issue=Invalid path [path]')
  })

  it('says which half a frame with no bridge host was waiting on', () => {
    expect(frameWithoutHostLine({ clientReady: false, snapshotReady: true })).toEqual({
      level: 'warn',
      code: 'web-shell-page',
      message: 'Web shell: page frame with no bridge host',
      detail: 'client=null snapshot=ok'
    })
  })
})
