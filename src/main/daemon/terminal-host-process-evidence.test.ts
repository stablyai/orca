// Pins the direction every arm of the daemon inspection collapse falls in: a
// foreground read that observed nothing must reach the caller as
// `unverifiable`, never as the `exited` the completion monitor acts on
// (docs/reference/ssh-execution-boundary.md).
import { describe, expect, it } from 'vitest'
import { buildDaemonInspectProcessResult } from './terminal-host-process-evidence'
import type { ForegroundProcessObservation } from './session-subprocess-handle'

function observed(processName: string | null): ForegroundProcessObservation {
  return { processName, evidence: { verdict: 'observed', processName } }
}

function unverifiable(processName: string | null, reason: string): ForegroundProcessObservation {
  return { processName, evidence: { verdict: 'unverifiable', reason } }
}

describe('buildDaemonInspectProcessResult', () => {
  it('reports a degraded read as unverifiable on both probes, never as an exit', () => {
    const result = buildDaemonInspectProcessResult(unverifiable('zsh', 'scan never settled'))

    expect(result.processEvidence?.foreground).toEqual({
      verdict: 'unverifiable',
      reason: 'scan never settled'
    })
    expect(result.processEvidence?.children).toEqual({
      verdict: 'unverifiable',
      reason: 'scan never settled'
    })
  })

  it('keeps the legacy fields byte-identical to the pre-evidence collapse', () => {
    // The exact payload an old client still receives: a degraded read publishes
    // the shell title it fell back to and hasChildProcesses:false. Only the
    // additive evidence field distinguishes it from an observed idle shell.
    const degraded = buildDaemonInspectProcessResult(unverifiable('zsh', 'scan never settled'))
    expect(degraded.foregroundProcess).toBe('zsh')
    expect(degraded.hasChildProcesses).toBe(false)

    const live = buildDaemonInspectProcessResult(observed('codex'))
    expect(live.foregroundProcess).toBe('codex')
    expect(live.hasChildProcesses).toBe(true)
  })

  it('calls children live only when the observation named a non-shell process', () => {
    expect(buildDaemonInspectProcessResult(observed('codex')).processEvidence?.children).toEqual({
      verdict: 'live'
    })
  })

  it('calls children exited only on a positive observation of an idle pane', () => {
    expect(buildDaemonInspectProcessResult(observed('zsh')).processEvidence?.children).toEqual({
      verdict: 'exited'
    })
    // The host watched the pty die: absence it observed itself.
    expect(buildDaemonInspectProcessResult(observed(null)).processEvidence?.children).toEqual({
      verdict: 'exited'
    })
  })

  it('never lets the children verdict outrank an unverifiable foreground', () => {
    // An agent name carried by a read nothing corroborated is still not proof
    // the agent is live, and a shell name is still not proof it exited.
    for (const name of ['codex', 'zsh', null]) {
      const children = buildDaemonInspectProcessResult(unverifiable(name, 'title read threw'))
        .processEvidence?.children
      expect(children?.verdict).toBe('unverifiable')
    }
  })
})
