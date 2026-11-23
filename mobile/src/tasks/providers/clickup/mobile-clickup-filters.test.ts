import { describe, expect, it } from 'vitest'
import type { ClickUpStatusOption } from '../../../../../src/shared/clickup/clickup-types'
import {
  DEFAULT_CLICKUP_FILTER,
  clickUpFilterKey,
  offeredClickUpStatuses,
  safeClickUpColor,
  toggleClickUpIncludeClosed,
  toggleClickUpStatus
} from './mobile-clickup-filters'

const open: ClickUpStatusOption = { name: 'to do', color: '#d3d3d3', type: 'open', orderIndex: 0 }
const review: ClickUpStatusOption = {
  name: 'in review',
  color: '#a875ff',
  type: 'custom',
  orderIndex: 1
}
const done: ClickUpStatusOption = {
  name: 'complete',
  color: '#6bc950',
  type: 'done',
  orderIndex: 2
}
const known = [open, review, done]

describe('ClickUp task filter', () => {
  it('offers closed statuses only while closed tasks are included', () => {
    expect(offeredClickUpStatuses(DEFAULT_CLICKUP_FILTER, known).map((s) => s.name)).toEqual([
      'to do',
      'in review'
    ])
    expect(
      offeredClickUpStatuses({ ...DEFAULT_CLICKUP_FILTER, includeClosed: true }, known).map(
        (s) => s.name
      )
    ).toEqual(['to do', 'in review', 'complete'])
  })

  it('keeps a selected status offered when the rows read no longer carry it', () => {
    const offered = offeredClickUpStatuses({ ...DEFAULT_CLICKUP_FILTER, statuses: ['blocked'] }, [
      open
    ])
    expect(offered.map((s) => s.name)).toEqual(['to do', 'blocked'])
  })

  it('drops a selected closed status when closed tasks stop being included', () => {
    const filter = { scope: 'all' as const, includeClosed: true, statuses: ['complete', 'to do'] }
    expect(toggleClickUpIncludeClosed(filter, known)).toEqual({
      scope: 'all',
      includeClosed: false,
      statuses: ['to do']
    })
  })

  it('toggles a status and omits an empty status list', () => {
    const selected = toggleClickUpStatus(DEFAULT_CLICKUP_FILTER, 'to do')
    expect(selected.statuses).toEqual(['to do'])
    expect(toggleClickUpStatus(selected, 'to do')).toEqual(DEFAULT_CLICKUP_FILTER)
  })

  it('keys lists by what they read, regardless of status order', () => {
    const a = clickUpFilterKey({ ...DEFAULT_CLICKUP_FILTER, statuses: ['b', 'a'] })
    const b = clickUpFilterKey({ ...DEFAULT_CLICKUP_FILTER, statuses: ['a', 'b'] })
    expect(a).toBe(b)
    expect(a).not.toBe(clickUpFilterKey({ ...DEFAULT_CLICKUP_FILTER, includeClosed: true }))
    expect(a).not.toBe(clickUpFilterKey({ ...DEFAULT_CLICKUP_FILTER, scope: 'all' }))
  })

  it('lets only plain hex colors reach a style', () => {
    expect(safeClickUpColor('#a875ff')).toBe('#a875ff')
    expect(safeClickUpColor('red; background: url(x)')).toBeUndefined()
    expect(safeClickUpColor('')).toBeUndefined()
  })
})
