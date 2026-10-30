import { describe, expect, it } from 'vitest'
import { createShellReadyScanState, scanForShellReady } from './local-pty-shell-ready'

describe('scanForShellReady', () => {
  it('flushes marker-like output when the full marker is not BEL-terminated', () => {
    const state = createShellReadyScanState()

    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-readyx')).toEqual({
      output: 'before \x1b]777;orca-shell-readyx',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, ' after')).toEqual({
      output: ' after',
      matched: false,
      postMarkerBytesObserved: false
    })
  })

  it('reports post-marker bytes only when bytes follow the BEL terminator in the matching call', () => {
    let state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready\x07')).toEqual({
      output: 'before ',
      matched: true,
      postMarkerBytesObserved: false
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready\x07% ')).toEqual({
      output: 'before % ',
      matched: true,
      postMarkerBytesObserved: true
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready')).toEqual({
      output: 'before ',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, '\x07')).toEqual({
      output: '',
      matched: true,
      postMarkerBytesObserved: false
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, '\x1b]777;orca-shell-ready')).toEqual({
      output: '',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, '\x07% ')).toEqual({
      output: '% ',
      matched: true,
      postMarkerBytesObserved: true
    })
  })
})
