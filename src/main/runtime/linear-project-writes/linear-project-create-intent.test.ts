import { describe, expect, it } from 'vitest'
import {
  projectMatchesCreateIntent,
  type LinearProjectCreateIntent,
  type LinearProjectCreateSnapshot
} from './linear-project-create-intent'

const WORKSPACE_ID = 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b'
const TEAM_A = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f'
const TEAM_B = 'd5e6f7a8-b9c0-4d1e-9f2a-3b4c5d6e7f80'
const USER_ID = 'e6f7a8b9-c0d1-4e2f-8a3b-4c5d6e7f8091'

function intent(overrides: Partial<LinearProjectCreateIntent> = {}): LinearProjectCreateIntent {
  return { workspaceId: WORKSPACE_ID, name: 'Aurora', teamIds: [TEAM_A], ...overrides }
}

function snapshot(
  overrides: Partial<LinearProjectCreateSnapshot> = {}
): LinearProjectCreateSnapshot {
  return {
    name: 'Aurora',
    description: '',
    content: null,
    status: { id: 'status-default' },
    lead: null,
    members: [],
    teams: [{ id: TEAM_A }],
    labels: [],
    priority: 3,
    startDate: null,
    targetDate: null,
    color: '#000000',
    ...overrides
  }
}

describe('projectMatchesCreateIntent', () => {
  it('ignores fields the create never requested, because Linear applies defaults', () => {
    expect(projectMatchesCreateIntent(snapshot(), intent())).toBe(true)
  })

  it('compares team ids as a set, not as an ordered list', () => {
    const stored = snapshot({ teams: [{ id: TEAM_B }, { id: TEAM_A }] })

    expect(projectMatchesCreateIntent(stored, intent({ teamIds: [TEAM_A, TEAM_B] }))).toBe(true)
    expect(projectMatchesCreateIntent(stored, intent({ teamIds: [TEAM_A] }))).toBe(false)
  })

  it('rejects a project whose name or requested reference differs', () => {
    expect(projectMatchesCreateIntent(snapshot({ name: 'Borealis' }), intent())).toBe(false)
    expect(projectMatchesCreateIntent(snapshot(), intent({ statusId: 'status-other' }))).toBe(false)
    expect(projectMatchesCreateIntent(snapshot(), intent({ leadId: USER_ID }))).toBe(false)
    expect(
      projectMatchesCreateIntent(snapshot({ lead: { id: USER_ID } }), intent({ leadId: USER_ID }))
    ).toBe(true)
  })

  it('matches requested prose after line-ending normalization and treats null as empty', () => {
    expect(
      projectMatchesCreateIntent(
        snapshot({ content: 'one\ntwo' }),
        intent({ content: 'one\r\ntwo' })
      )
    ).toBe(true)
    expect(projectMatchesCreateIntent(snapshot({ content: null }), intent({ content: '' }))).toBe(
      true
    )
    expect(
      projectMatchesCreateIntent(snapshot({ description: 'x' }), intent({ description: '' }))
    ).toBe(false)
  })

  it('keeps priority 0 comparable and matches color case-insensitively', () => {
    expect(projectMatchesCreateIntent(snapshot({ priority: 0 }), intent({ priority: 0 }))).toBe(
      true
    )
    expect(projectMatchesCreateIntent(snapshot({ priority: 3 }), intent({ priority: 0 }))).toBe(
      false
    )
    expect(
      projectMatchesCreateIntent(snapshot({ color: '#5e6ad2' }), intent({ color: '#5E6AD2' }))
    ).toBe(true)
  })

  it('compares requested member and label sets while ignoring unrequested ones', () => {
    const stored = snapshot({ members: [{ id: USER_ID }], labels: [{ id: TEAM_B }] })

    expect(projectMatchesCreateIntent(stored, intent())).toBe(true)
    expect(projectMatchesCreateIntent(stored, intent({ memberIds: [USER_ID] }))).toBe(true)
    expect(projectMatchesCreateIntent(stored, intent({ memberIds: [] }))).toBe(false)
    expect(projectMatchesCreateIntent(stored, intent({ labelIds: [USER_ID] }))).toBe(false)
  })
})
