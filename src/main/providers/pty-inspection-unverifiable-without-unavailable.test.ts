import { describe, expect, it } from 'vitest'
import { buildDaemonInspectProcessResult } from '../daemon/terminal-host-process-evidence'
import { readPtyProcessInspectionEvidence } from '../../shared/pty-process-inspection-evidence'
import { classifyLocalPtyChildProcesses } from './local-pty-process-evidence'
import type { PtyProcessInspection } from './pty-process-inspection'

/**
 * Reachability pin for the tab-close guard's `unverifiable` arm.
 *
 * The guard lives in the renderer and cannot import these producers across the tsconfig
 * project boundary, so the claim it rests on is pinned here, where they live: a host that
 * was *reached* can publish "could not tell" as `hasChildProcesses: false` with no
 * `unavailable` flag — byte-identical to an observed-idle shell. Per
 * docs/reference/ssh-execution-boundary.md that is `unverifiable`, never exit evidence, and
 * the guard's counterpart cases are in
 * src/renderer/src/components/terminal/running-terminal-close-unverifiable-children.test.ts.
 */
describe('an in-contact PTY probe that could not determine child processes', () => {
  /** Assembles the wire result exactly as LocalPtyProvider.inspectProcess does, field for
   *  field, so the shape asserted here is the one the provider actually publishes. */
  function localInspection(
    foreground: Parameters<typeof classifyLocalPtyChildProcesses>[0]['foreground'],
    titleRead: Parameters<typeof classifyLocalPtyChildProcesses>[0]['titleRead'],
    shell: string | undefined,
    foregroundProcess: string | null
  ): PtyProcessInspection {
    const children = classifyLocalPtyChildProcesses({
      procPresent: true,
      titleRead,
      shell,
      foreground
    })
    return {
      foregroundProcess,
      hasChildProcesses: children.hasChildProcesses,
      processEvidence: { foreground, children: children.evidence }
    }
  }

  /** What a reader that ignores `processEvidence` concludes from the published legacy pair —
   *  the same collapse every pre-evidence consumer applies, read through the shared reader
   *  instead of restated here. */
  function legacyOnlyChildrenVerdict(inspection: PtyProcessInspection): string {
    return readPtyProcessInspectionEvidence({
      foregroundProcess: inspection.foregroundProcess,
      hasChildProcesses: inspection.hasChildProcesses
    }).children.verdict
  }

  // node-pty's POSIX title read silently falls back to the spawned shell name when the
  // native read fails, so under the same distress that degrades the scan "title == shell"
  // observes nothing. This is the load-bearing local shape.
  it('publishes a degraded local scan as unverifiable with no unavailable flag', () => {
    const inspection = localInspection(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  it('publishes a failed pty title read the same way', () => {
    const inspection = localInspection(
      { verdict: 'observed', processName: null },
      { ok: false },
      'zsh',
      null
    )

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  // A daemon pane's only child signal IS its foreground observation, so a foreground read
  // that did not land reaches the same shape from a second, independent producer.
  it('publishes a daemon pane with an unlanded foreground observation the same way', () => {
    const inspection = buildDaemonInspectProcessResult({
      processName: 'zsh',
      evidence: {
        verdict: 'unverifiable',
        reason: 'subprocess handle reports no foreground evidence'
      }
    })

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  // The collapse itself, stated through the reader the guards call rather than by comparing
  // two results of the helper above: those two inputs differ only in the foreground verdict,
  // and no arm of the classifier separates them on the legacy pair, so an equality between
  // them holds whatever that arm returns. Reading each one back with the evidence stripped is
  // the claim that can actually fail — it reddens the moment the boolean stops collapsing.
  it('reads as an exit to a consumer that sees only the legacy fields', () => {
    const degraded = localInspection(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )
    const observed = localInspection(
      { verdict: 'observed', processName: 'zsh' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )

    expect(observed.processEvidence?.children.verdict).toBe('exited')
    expect(degraded.processEvidence?.children.verdict).toBe('unverifiable')
    expect(legacyOnlyChildrenVerdict(degraded)).toBe('exited')
    expect(legacyOnlyChildrenVerdict(observed)).toBe('exited')
  })

  // The local classifier can also publish `false` beside a positively observed 'live' when
  // a stale shell title would otherwise contradict the completed scan — the collapse
  // pointing the other way, and the reason the guard reads the verdict for `live` too.
  it('publishes an observed live child as a false boolean when the title went stale', () => {
    const inspection = localInspection(
      { verdict: 'observed', processName: 'claude' },
      { ok: true, title: 'zsh' },
      'zsh',
      'claude'
    )

    expect(inspection.processEvidence?.children.verdict).toBe('live')
    expect(inspection.hasChildProcesses).toBe(false)
  })
})
