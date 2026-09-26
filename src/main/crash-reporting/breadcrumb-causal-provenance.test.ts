import { describe, expect, it } from 'vitest'

import type { CrashReportBreadcrumb } from '../../shared/crash-reporting'
import {
  annotateBreadcrumbCausalProvenance,
  breadcrumbProvenanceDetails,
  BREADCRUMB_CAUSAL_WINDOW_MS
} from './breadcrumb-causal-provenance'

const GONE_AT = Date.parse('2025-08-14T16:56:04.149Z')

function crumb(name: string, ageMs: number): CrashReportBreadcrumb {
  return { createdAt: new Date(GONE_AT - ageMs).toISOString(), name, data: { pid: 5732 } }
}

describe('annotateBreadcrumbCausalProvenance', () => {
  it('marks the crumbs too old to explain the death and leaves the rest untouched', () => {
    const recent = crumb('renderer_memory_highwater', 1_200)
    const stale = crumb('self_tree_kill', 1_046_666)

    expect(annotateBreadcrumbCausalProvenance([stale, recent], GONE_AT)).toEqual([
      {
        createdAt: stale.createdAt,
        name: 'self_tree_kill',
        data: { pid: 5732, ageMs: 1_046_666, outsideCausalWindow: true }
      },
      recent
    ])
  })

  it('keeps a crumb on the window boundary readable as causal', () => {
    const boundary = crumb('self_tree_kill', BREADCRUMB_CAUSAL_WINDOW_MS)

    expect(annotateBreadcrumbCausalProvenance([boundary], GONE_AT)).toEqual([boundary])
  })

  it('leaves an unparseable timestamp alone rather than guessing an age', () => {
    const broken: CrashReportBreadcrumb = { createdAt: 'not-a-date', name: 'gpu_crashed' }

    expect(annotateBreadcrumbCausalProvenance([broken], GONE_AT)).toEqual([broken])
    expect(breadcrumbProvenanceDetails([broken], GONE_AT)).toEqual({ breadcrumbCount: 1 })
  })
})

describe('breadcrumbProvenanceDetails', () => {
  it('reports the newest crumb, which is the one a reader treats as adjacent', () => {
    expect(
      breadcrumbProvenanceDetails(
        [crumb('gpu_crashed', 1_050_000), crumb('self_tree_kill', 1_046_666)],
        GONE_AT
      )
    ).toEqual({
      breadcrumbCount: 2,
      breadcrumbNewestAgeMs: 1_046_666,
      breadcrumbNewestName: 'self_tree_kill',
      breadcrumbsInCausalWindowCount: 0,
      breadcrumbCausalWindowMs: BREADCRUMB_CAUSAL_WINDOW_MS
    })
  })

  it('counts the window boundary the same way the annotation reads it', () => {
    // The annotation keeps a 60s crumb causal; the count has its own copy of that
    // comparison, and the two silently disagreeing is the bug this pins.
    expect(
      breadcrumbProvenanceDetails(
        [
          crumb('gpu_crashed', BREADCRUMB_CAUSAL_WINDOW_MS + 1),
          crumb('self_tree_kill', BREADCRUMB_CAUSAL_WINDOW_MS)
        ],
        GONE_AT
      )
    ).toEqual({
      breadcrumbCount: 2,
      breadcrumbNewestAgeMs: BREADCRUMB_CAUSAL_WINDOW_MS,
      breadcrumbNewestName: 'self_tree_kill',
      breadcrumbsInCausalWindowCount: 1,
      breadcrumbCausalWindowMs: BREADCRUMB_CAUSAL_WINDOW_MS
    })
  })

  it('never ages a crumb recorded after the death was stamped into the future', () => {
    // `goneAt` is stamped at the top of recordProcessGoneCrash and the snapshot is
    // taken later, so a crumb written in between is legitimately newer than it.
    expect(breadcrumbProvenanceDetails([crumb('renderer_gone_recorded', -25)], GONE_AT)).toEqual({
      breadcrumbCount: 1,
      breadcrumbNewestAgeMs: 0,
      breadcrumbNewestName: 'renderer_gone_recorded',
      breadcrumbsInCausalWindowCount: 1,
      breadcrumbCausalWindowMs: BREADCRUMB_CAUSAL_WINDOW_MS
    })
  })

  it('counts an empty ring without inventing an age for it', () => {
    expect(breadcrumbProvenanceDetails([], GONE_AT)).toEqual({ breadcrumbCount: 0 })
  })
})
