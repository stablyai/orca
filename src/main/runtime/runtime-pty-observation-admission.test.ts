import { describe, expect, it } from 'vitest'
import {
  createPendingPtyObservationSummary,
  isNewerPtyObservationStamp,
  MAX_PENDING_PTY_OBSERVATION_SOURCES,
  MAX_PTY_OBSERVATION_CWD_CHARS,
  MAX_PTY_OBSERVATION_TITLE_CHARS,
  pendingPtyObservationSummaryIsEmpty,
  ptyObservationSourceKey,
  recordPtyObservationCwd,
  recordPtyObservationLifecycle,
  recordPtyObservationTitle,
  UNKNOWN_PTY_OBSERVATION_SOURCE_KEY,
  type PtyObservationStamp
} from './runtime-pty-observation-admission'

function stamp(ingestionOrdinal: number, chunkOrder = 0): PtyObservationStamp {
  return { ingestionOrdinal, chunkOrder, observedAtEpochMs: 1_700_000_000_000 + ingestionOrdinal }
}

describe('pty observation source keys', () => {
  it('keeps an omitted incarnation distinct from every proven one', () => {
    expect(ptyObservationSourceKey(undefined)).toBe(UNKNOWN_PTY_OBSERVATION_SOURCE_KEY)
    expect(ptyObservationSourceKey('inc-a')).not.toBe(UNKNOWN_PTY_OBSERVATION_SOURCE_KEY)
    expect(ptyObservationSourceKey('inc-a')).not.toBe(ptyObservationSourceKey('inc-b'))
    expect(ptyObservationSourceKey('inc-a')).toBe(ptyObservationSourceKey('inc-a'))
  })
})

describe('pty observation stamps', () => {
  it('orders within one chunk, not only by ingestion', () => {
    // Why not output sequence: a salvaged query copy carries zero sequence weight,
    // so two observations can share one sequence value.
    expect(isNewerPtyObservationStamp(stamp(4, 2), stamp(4, 1))).toBe(true)
    expect(isNewerPtyObservationStamp(stamp(4, 1), stamp(4, 2))).toBe(false)
    expect(isNewerPtyObservationStamp(stamp(5, 0), stamp(4, 9))).toBe(true)
    expect(isNewerPtyObservationStamp(stamp(3, 9), stamp(4, 0))).toBe(false)
  })
})

describe('pending pty observation summary', () => {
  it('starts empty and keeps only the latest stamped evidence', () => {
    const summary = createPendingPtyObservationSummary()
    expect(pendingPtyObservationSummaryIsEmpty(summary)).toBe(true)

    recordPtyObservationTitle(
      summary,
      { rawTitle: 'codex working', normalizedTitle: 'codex working', identityOnly: false },
      stamp(1)
    )
    recordPtyObservationTitle(
      summary,
      { rawTitle: 'codex done', normalizedTitle: 'codex done', identityOnly: false },
      stamp(2)
    )
    expect(summary.title?.value.rawTitle).toBe('codex done')
    expect(pendingPtyObservationSummaryIsEmpty(summary)).toBe(false)
  })

  it('refuses a late predecessor title after an early final title', () => {
    const summary = createPendingPtyObservationSummary()
    recordPtyObservationTitle(
      summary,
      { rawTitle: 'final', normalizedTitle: 'final', identityOnly: false },
      stamp(9)
    )
    const applied = recordPtyObservationTitle(
      summary,
      { rawTitle: 'intermediate', normalizedTitle: 'intermediate', identityOnly: false },
      stamp(4)
    )
    expect(applied).toBe(false)
    expect(summary.title?.value.rawTitle).toBe('final')
  })

  it('does not grow a journal when the same output repeats', () => {
    const summary = createPendingPtyObservationSummary()
    for (let index = 0; index < 500; index += 1) {
      recordPtyObservationTitle(
        summary,
        { rawTitle: `frame ${index}`, normalizedTitle: `frame ${index}`, identityOnly: false },
        stamp(index + 1)
      )
      recordPtyObservationLifecycle(
        summary,
        { kind: 'agent-status', status: 'working' },
        stamp(index + 1, 1)
      )
    }
    expect(Object.keys(summary)).toEqual([
      'title',
      'explicitStatus',
      'cwd',
      'lifecycle',
      'rejectedOversizedObservations'
    ])
    expect(summary.title?.value.rawTitle).toBe('frame 499')
  })

  it('distinguishes a later activity from an earlier completion', () => {
    const summary = createPendingPtyObservationSummary()
    recordPtyObservationLifecycle(summary, { kind: 'command-finished', exitCode: 0 }, stamp(1))
    recordPtyObservationLifecycle(summary, { kind: 'agent-status', status: 'working' }, stamp(2))
    expect(summary.lifecycle?.value).toEqual({ kind: 'agent-status', status: 'working' })

    const completion = createPendingPtyObservationSummary()
    recordPtyObservationLifecycle(completion, { kind: 'agent-status', status: 'working' }, stamp(1))
    recordPtyObservationLifecycle(completion, { kind: 'command-finished', exitCode: 3 }, stamp(2))
    expect(completion.lifecycle?.value).toEqual({ kind: 'command-finished', exitCode: 3 })
  })

  it('rejects oversized evidence instead of truncating it into a different classification', () => {
    const summary = createPendingPtyObservationSummary()
    const oversizedTitle = 'x'.repeat(MAX_PTY_OBSERVATION_TITLE_CHARS + 1)
    expect(
      recordPtyObservationTitle(
        summary,
        { rawTitle: oversizedTitle, normalizedTitle: oversizedTitle, identityOnly: false },
        stamp(1)
      )
    ).toBe(false)
    expect(summary.title).toBeNull()

    expect(
      recordPtyObservationCwd(summary, 'y'.repeat(MAX_PTY_OBSERVATION_CWD_CHARS + 1), stamp(2))
    ).toBe(false)
    expect(summary.cwd).toBeNull()
    expect(summary.rejectedOversizedObservations).toBe(2)

    // A bounded partial-tail parser does not bound a complete title in one chunk,
    // so the at-limit title must still be accepted whole.
    expect(
      recordPtyObservationTitle(
        summary,
        {
          rawTitle: 'z'.repeat(MAX_PTY_OBSERVATION_TITLE_CHARS),
          normalizedTitle: 'z'.repeat(MAX_PTY_OBSERVATION_TITLE_CHARS),
          identityOnly: false
        },
        stamp(3)
      )
    ).toBe(true)
  })
})

describe('candidate capacity bound', () => {
  it('matches the audited whole-operation retry accounting', () => {
    // 2 outer withDaemonRetry attempts x 2 inner transmitted createOrAttach requests
    // (initial + finishSpawn's kill/recreate history retry). The
    // NdjsonLineTooLongError inline-seed fallback throws in encodeNdjson before
    // socket.write, so it adds no emitting Session incarnation.
    expect(MAX_PENDING_PTY_OBSERVATION_SOURCES).toBe(2 * 2)
  })
})
