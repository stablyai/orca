// R3. The criteria set is authoritative; the model only annotates it.
//
// Every case here is a way a model response can disagree with durable state, and
// in all of them the criteria win.
import { describe, expect, it } from 'vitest'
import { reconcileCoverage } from './audited-plan-coverage-reconcile'
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'

const CRITERIA: AuditedAcceptanceCriterion[] = [
  { id: 'ac1', text: 'First', covered: false },
  { id: 'ac2', text: 'Second', covered: false }
]

describe('reconcileCoverage', () => {
  it('maps reported entries onto their criteria', () => {
    expect(
      reconcileCoverage(CRITERIA, [
        { id: 'ac1', covered: true, note: 'Step 3' },
        { id: 'ac2', covered: false, note: null }
      ])
    ).toEqual([
      { criterionId: 'ac1', covered: true, note: 'Step 3' },
      { criterionId: 'ac2', covered: false, note: null }
    ])
  })

  it('drops an id that is not a real criterion', () => {
    const rows = reconcileCoverage(CRITERIA, [
      { id: 'invented', covered: true, note: 'nice try' },
      { id: 'ac1', covered: true, note: null }
    ])
    expect(rows.map((r) => r.criterionId)).toEqual(['ac1', 'ac2'])
    expect(rows.find((r) => r.criterionId === 'ac2')?.covered).toBe(false)
  })

  // First-wins, not last-wins: a model that contradicts itself must not be able
  // to upgrade a criterion to covered by simply repeating it later.
  it('keeps the FIRST entry for a duplicated id', () => {
    const rows = reconcileCoverage(CRITERIA, [
      { id: 'ac1', covered: false, note: 'honest' },
      { id: 'ac1', covered: true, note: 'second thoughts' }
    ])
    expect(rows[0]).toEqual({ criterionId: 'ac1', covered: false, note: 'honest' })
  })

  // Silence is not coverage.
  it('records an unmentioned criterion as uncovered', () => {
    expect(reconcileCoverage(CRITERIA, [{ id: 'ac1', covered: true, note: null }])).toEqual([
      { criterionId: 'ac1', covered: true, note: null },
      { criterionId: 'ac2', covered: false, note: null }
    ])
  })

  it('records every criterion as uncovered when nothing is reported', () => {
    expect(reconcileCoverage(CRITERIA, [])).toEqual([
      { criterionId: 'ac1', covered: false, note: null },
      { criterionId: 'ac2', covered: false, note: null }
    ])
  })

  it('always returns one row per criterion, in criteria order', () => {
    const rows = reconcileCoverage(CRITERIA, [
      { id: 'ac2', covered: true, note: null },
      { id: 'ac1', covered: true, note: null }
    ])
    expect(rows.map((r) => r.criterionId)).toEqual(['ac1', 'ac2'])
  })

  it('returns nothing for an empty criteria set', () => {
    expect(reconcileCoverage([], [{ id: 'ac1', covered: true, note: null }])).toEqual([])
  })
})
