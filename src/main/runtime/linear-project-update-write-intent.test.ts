import { describe, expect, it } from 'vitest'
import {
  projectUpdateMatchesAddIntent,
  type LinearProjectUpdateAddIntent,
  type LinearProjectUpdateIntentSnapshot
} from './linear-project-update-write-intent'

const PROJECT_ID = '0f3a1c9e-2b7d-4a51-9c62-8d5f0e7b4a13'

function snapshot(
  overrides: Partial<LinearProjectUpdateIntentSnapshot> = {}
): LinearProjectUpdateIntentSnapshot {
  return {
    projectId: PROJECT_ID,
    body: 'Week 3 status.\nAll green.',
    health: 'onTrack',
    isDiffHidden: false,
    ...overrides
  }
}

function intent(
  overrides: Partial<LinearProjectUpdateAddIntent> = {}
): LinearProjectUpdateAddIntent {
  return {
    projectId: PROJECT_ID,
    body: 'Week 3 status.\nAll green.',
    isDiffHidden: false,
    ...overrides
  }
}

describe('projectUpdateMatchesAddIntent', () => {
  it('matches when the project, body, requested health, and hide-diff all agree', () => {
    expect(projectUpdateMatchesAddIntent(snapshot(), intent({ health: 'onTrack' }))).toBe(true)
  })

  it('ignores health that the caller never requested', () => {
    expect(projectUpdateMatchesAddIntent(snapshot({ health: 'atRisk' }), intent())).toBe(true)
  })

  it('rejects a post on another project even when the body matches', () => {
    const other = snapshot({ projectId: 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b' })
    expect(projectUpdateMatchesAddIntent(other, intent())).toBe(false)
  })

  it('rejects a different body, health, or hide-diff value', () => {
    expect(projectUpdateMatchesAddIntent(snapshot({ body: 'Week 4 status.' }), intent())).toBe(
      false
    )
    expect(
      projectUpdateMatchesAddIntent(snapshot({ health: 'offTrack' }), intent({ health: 'onTrack' }))
    ).toBe(false)
    expect(projectUpdateMatchesAddIntent(snapshot({ isDiffHidden: true }), intent())).toBe(false)
  })

  it('compares bodies with line endings normalized on both sides', () => {
    const stored = snapshot({ body: 'Week 3 status.\r\nAll green.' })
    expect(projectUpdateMatchesAddIntent(stored, intent())).toBe(true)
  })

  it('does not trim body whitespace before comparing', () => {
    expect(
      projectUpdateMatchesAddIntent(snapshot(), intent({ body: ' Week 3 status.\nAll green.' }))
    ).toBe(false)
  })
})
