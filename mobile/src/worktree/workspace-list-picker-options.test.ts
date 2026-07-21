import { describe, expect, it } from 'vitest'
import {
  MOBILE_PROJECT_GROUP_SYNC_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../src/shared/protocol-version'
import {
  WORKSPACE_GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS,
  workspaceGroupOptionsForCapabilities
} from './workspace-list-picker-options'

describe('WORKSPACE_SORT_OPTIONS', () => {
  it('keeps the persisted sort values stable for desktop compatibility', () => {
    expect(WORKSPACE_SORT_OPTIONS.map((option) => option.value)).toEqual([
      'smart',
      'name',
      'recent',
      'repo',
      'manual'
    ])
  })

  it('keeps the smart sort value while showing the agent activity label', () => {
    expect(WORKSPACE_SORT_OPTIONS.find((option) => option.value === 'smart')).toEqual({
      value: 'smart',
      label: 'Agent activity',
      subtitle: 'Agents that need attention, then recent activity'
    })
  })
})

describe('WORKSPACE_GROUP_OPTIONS', () => {
  it('keeps the persisted group values stable for desktop compatibility', () => {
    expect(WORKSPACE_GROUP_OPTIONS.map((option) => option.value)).toEqual([
      'none',
      'workspaceStatus',
      'repo',
      'prStatus',
      'projectGroup'
    ])
  })

  it('labels the project-group mode', () => {
    expect(WORKSPACE_GROUP_OPTIONS.find((option) => option.value === 'projectGroup')).toEqual({
      value: 'projectGroup',
      label: 'Project Group'
    })
  })

  it('does not offer project-group until the host can persist the new enum', () => {
    expect(workspaceGroupOptionsForCapabilities([]).map((option) => option.value)).not.toContain(
      'projectGroup'
    )
    expect(
      workspaceGroupOptionsForCapabilities([MOBILE_PROJECT_GROUP_SYNC_RUNTIME_CAPABILITY]).map(
        (option) => option.value
      )
    ).toContain('projectGroup')
  })

  it('advertises the project-group sync contract from current hosts', () => {
    expect(RUNTIME_CAPABILITIES).toContain(MOBILE_PROJECT_GROUP_SYNC_RUNTIME_CAPABILITY)
  })
})
