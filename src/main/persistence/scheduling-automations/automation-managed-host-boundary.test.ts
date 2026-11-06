import { describe, expect, it } from 'vitest'
import type { AutomationCreateInput } from '../../../shared/automations-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { createAutomation } from './automation-definition-operations'

// Desktop rows on a managed SSH host never run; the desktop store refuses new ones for any caller.
describe('desktop automation create on a managed SSH host', () => {
  it('refuses the write and keeps the store unchanged', () => {
    const state = getDefaultPersistedState('/home/me')
    state.sshTargets = [
      {
        id: 'box',
        label: 'Build box',
        host: 'box',
        port: 22,
        username: 'me',
        generation: 3,
        orcadFence: { environmentId: 'env-1' }
      }
    ]
    state.repos = [
      {
        id: 'repo-1',
        path: '/srv/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: 'box'
      }
    ]
    const input: AutomationCreateInput = {
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'repo-1',
      workspaceMode: 'new_per_run',
      rrule: 'FREQ=DAILY',
      dtstart: 1,
      timezone: 'UTC'
    }
    const operations = {
      state,
      storageAuthority: 'desktop' as const,
      flush: () => undefined,
      recordCreated: () => undefined
    }

    expect(() => createAutomation(operations, input)).toThrow()
    expect(state.automations ?? []).toEqual([])
  })
})
