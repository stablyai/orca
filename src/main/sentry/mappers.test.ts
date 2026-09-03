import { describe, expect, it } from 'vitest'
import { mapEvent, mapIssue } from './mappers'

describe('Sentry response mapping', () => {
  it('maps issue counts and assignment without retaining unknown top-level data', () => {
    expect(
      mapIssue({
        id: '42',
        shortId: 'WEB-42',
        title: 'TypeError',
        count: '19',
        userCount: 3,
        status: 'unresolved',
        priority: 'high',
        assignedTo: { type: 'team', id: '7', name: 'Web' },
        project: { id: '2', slug: 'web', name: 'Web' },
        secret: 'discarded'
      })
    ).toMatchObject({
      id: '42',
      shortId: 'WEB-42',
      count: 19,
      priority: 'high',
      assignedTo: { type: 'team', id: '7', name: 'Web' }
    })
  })

  it('maps exception frames and breadcrumbs from event entries', () => {
    const event = mapEvent({
      id: 'event-1',
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                type: 'TypeError',
                stacktrace: { frames: [{ filename: 'app.ts', lineNo: 8, inApp: true }] }
              }
            ]
          }
        },
        { type: 'breadcrumbs', data: { values: [{ category: 'ui.click', message: 'Save' }] } }
      ]
    })
    expect(event.exceptions[0]?.frames[0]).toMatchObject({
      filename: 'app.ts',
      lineNo: 8,
      inApp: true
    })
    expect(event.breadcrumbs[0]).toMatchObject({ category: 'ui.click', message: 'Save' })
  })
})
