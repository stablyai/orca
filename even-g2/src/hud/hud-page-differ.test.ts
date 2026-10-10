import { describe, expect, it } from 'vitest'
import { planHudRender } from './hud-page-differ'
import { buildHudPage } from './hud-page-spec'

describe('planHudRender', () => {
  it('creates on the very first render (no previous page, startup not yet spent)', () => {
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    expect(planHudRender(null, next, false)).toEqual({ kind: 'create', page: next })
  })

  it('rebuilds (never re-creates) when the queue was invalidated: no previous page but startup already spent', () => {
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    expect(planHudRender(null, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('creates when startup has not been spent yet, even with a previous page', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B2', footer: 'F' })
    expect(planHudRender(prev, next, false)).toEqual({ kind: 'create', page: next })
  })

  it('noop when pages are identical', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'noop' })
  })

  it('upgrades when 1 text container content changes', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B2', footer: 'F' })
    const plan = planHudRender(prev, next, true)
    expect(plan.kind).toBe('upgrade')
    if (plan.kind === 'upgrade') {
      expect(plan.updates).toEqual([{ id: 2, name: 'body', content: 'B2' }])
    }
  })

  it('upgrades when exactly 2 text containers change', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F' })
    const plan = planHudRender(prev, next, true)
    expect(plan.kind).toBe('upgrade')
    if (plan.kind === 'upgrade') {
      expect(plan.updates).toHaveLength(2)
    }
  })

  it('rebuilds when 3 text containers change', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H2', body: 'B2', footer: 'F2' })
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('rebuilds when list items change', () => {
    const prev = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'b'], footer: 'F' })
    const next = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'c'], footer: 'F' })
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('rebuilds on a layout switch (skeleton mismatch)', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'list', header: 'H', items: ['a'], footer: 'F' })
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('rebuilds on a geometry change even if content is identical', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    next.containers[1] = { ...next.containers[1]!, width: 500 } as (typeof next.containers)[1]
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('rebuilds on a border-only style change even if text content is identical', () => {
    const prev = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    const next = buildHudPage({ layout: 'text', header: 'H', body: 'B', footer: 'F' })
    next.containers[1] = {
      ...next.containers[1]!,
      borderWidth: 2,
      borderColor: 5
    } as (typeof next.containers)[1]
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })

  it('rebuilds on a selection-border-only change on a list container', () => {
    const prev = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'b'], footer: 'F' })
    const next = buildHudPage({ layout: 'list', header: 'H', items: ['a', 'b'], footer: 'F' })
    next.containers[1] = {
      ...next.containers[1]!,
      showSelectionBorder: false
    } as (typeof next.containers)[1]
    expect(planHudRender(prev, next, true)).toEqual({ kind: 'rebuild', page: next })
  })
})
