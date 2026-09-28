import { describe, expect, it } from 'vitest'
import { createAnnouncedNotificationRegistry } from './announced-notification-registry'

describe('createAnnouncedNotificationRegistry', () => {
  it('hands back each subject once, newest last, without duplicates', () => {
    const registry = createAnnouncedNotificationRegistry()
    registry.record('pane-a', 'id-1')
    registry.record('pane-a', 'id-2')
    registry.record('pane-a', 'id-1')
    registry.record('pane-b', 'id-3')
    expect(registry.take('pane-a')).toEqual(['id-2', 'id-1'])
    expect(registry.take('pane-a')).toEqual([])
    expect(registry.take('pane-b')).toEqual(['id-3'])
  })

  it('evicts the least recently announced subject and caps ids per subject', () => {
    const registry = createAnnouncedNotificationRegistry({ maxSubjects: 2, maxIdsPerSubject: 2 })
    registry.record('old', 'id-old')
    registry.record('busy', 'id-1')
    registry.record('old', 'id-old-2')
    registry.record('busy', 'id-2')
    registry.record('busy', 'id-3')
    registry.record('new', 'id-new')
    // 'old' was last announced before 'busy', so 'new' evicts it; 'busy' keeps only its newest two.
    expect(registry.take('old')).toEqual([])
    expect(registry.take('busy')).toEqual(['id-2', 'id-3'])
    expect(registry.take('new')).toEqual(['id-new'])
  })
})
