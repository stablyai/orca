import { describe, expect, it } from 'vitest'
import {
  createPaneExitScanState,
  PANE_EXIT_MARKER_PREFIX,
  resolvePaneProcessExitCode,
  scanPaneExitMarker
} from './shell-pane-exit-scanner'

describe('resolvePaneProcessExitCode', () => {
  it('does not report exit 42 as 0 when the trampoline published 42', () => {
    expect(resolvePaneProcessExitCode(0, 42)).toBe(42)
  })

  it('keeps a direct non-zero process status', () => {
    expect(resolvePaneProcessExitCode(42, null)).toBe(42)
  })

  it('keeps an abnormal negative process status over a reported code', () => {
    expect(resolvePaneProcessExitCode(-1, 42)).toBe(-1)
  })

  it('reports 0 when neither source has a non-zero status', () => {
    expect(resolvePaneProcessExitCode(0, null)).toBe(0)
    expect(resolvePaneProcessExitCode(0, 0)).toBe(0)
  })
})

describe('scanPaneExitMarker', () => {
  it('extracts the last complete pane-exit marker and strips it from output', () => {
    const state = createPaneExitScanState()
    expect(scanPaneExitMarker(state, `before${PANE_EXIT_MARKER_PREFIX}7\x07after`)).toEqual({
      output: 'beforeafter',
      exitCode: 7
    })
    expect(
      scanPaneExitMarker(state, `${PANE_EXIT_MARKER_PREFIX}1\x07${PANE_EXIT_MARKER_PREFIX}42\x07`)
    ).toEqual({
      output: '',
      exitCode: 42
    })
  })

  it('reassembles a marker split across PTY chunks', () => {
    const state = createPaneExitScanState()
    expect(scanPaneExitMarker(state, `pre${PANE_EXIT_MARKER_PREFIX}4`)).toEqual({
      output: 'pre',
      exitCode: null
    })
    expect(scanPaneExitMarker(state, '2\x07post')).toEqual({
      output: 'post',
      exitCode: 42
    })
  })

  it('does not treat a numeric prefix as a pane-exit status', () => {
    const state = createPaneExitScanState()
    expect(scanPaneExitMarker(state, `${PANE_EXIT_MARKER_PREFIX}42junk\x07keep`)).toEqual({
      output: 'keep',
      exitCode: null
    })
    expect(resolvePaneProcessExitCode(0, null)).toBe(0)
  })
})
