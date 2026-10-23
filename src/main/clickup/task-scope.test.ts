import { describe, expect, it } from 'vitest'
import {
  appendClickUpTaskScope,
  clickUpTaskPagePath,
  clickUpTaskScopeKey,
  normalizeClickUpTaskScope
} from './task-scope'

describe('ClickUp task scope', () => {
  it('drops empty or malformed scope input', () => {
    expect(normalizeClickUpTaskScope(undefined)).toBeUndefined()
    expect(normalizeClickUpTaskScope({ spaceId: ' ', listIds: [], statuses: [3] })).toBeUndefined()
    expect(
      normalizeClickUpTaskScope({ spaceId: ' 901 ', listIds: ['a', ''], statuses: ['to do'] })
    ).toEqual({ spaceId: '901', listIds: ['a'], statuses: ['to do'] })
  })

  it('narrows the team task query on the server', () => {
    const query = new URLSearchParams({ include_closed: 'false' })
    appendClickUpTaskScope(query, {
      spaceId: '901',
      listIds: ['sprint-12'],
      statuses: ['to do', 'on prod env']
    })
    expect(query.getAll('space_ids[]')).toEqual(['901'])
    expect(query.getAll('list_ids[]')).toEqual(['sprint-12'])
    expect(query.getAll('statuses[]')).toEqual(['to do', 'on prod env'])
    // Named statuses must reach closed tasks too.
    expect(query.get('include_closed')).toBe('true')
  })

  it('reads one List through the List endpoint so added (TIML) tasks are included', () => {
    const path = clickUpTaskPagePath('1234567', new URLSearchParams({ page: '0' }), {
      spaceId: '70001189689',
      listIds: ['700021931549'],
      statuses: ['in dev process']
    })
    const [pathname, search] = path.split('?')
    const query = new URLSearchParams(search)
    expect(pathname).toBe('/list/700021931549/task')
    expect(query.get('include_timl')).toBe('true')
    expect(query.getAll('statuses[]')).toEqual(['in dev process'])
    expect(query.has('list_ids[]')).toBe(false)
    expect(query.has('space_ids[]')).toBe(false)
  })

  it('keeps Space and multi-List scopes on the Workspace endpoint', () => {
    expect(clickUpTaskPagePath('1234567', new URLSearchParams(), { spaceId: '901' })).toBe(
      '/team/1234567/task?space_ids%5B%5D=901'
    )
    expect(clickUpTaskPagePath('1234567', new URLSearchParams(), { listIds: ['a', 'b'] })).toMatch(
      /^\/team\/1234567\/task\?list_ids/
    )
  })

  it('keys equivalent scopes the same regardless of order', () => {
    expect(clickUpTaskScopeKey({ spaceId: 's', statuses: ['b', 'a'] })).toBe(
      clickUpTaskScopeKey({ spaceId: 's', statuses: ['a', 'b'] })
    )
  })
})
