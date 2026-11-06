import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import {
  handOffManagedHostAutomation,
  type ManagedHostHandoffDeps
} from './managed-host-automation-handoff'

const BOX: SshTarget = {
  id: 'box',
  label: 'Build box',
  host: 'box',
  port: 22,
  username: 'me',
  orcadFence: { environmentId: 'env-1' }
}

function leftover(): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-1',
    executionTargetType: 'ssh',
    executionTargetId: 'box',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1
  }
}

/** A desktop holding one leftover, and a managed server that stores creates by key. */
function world(serverHasProject: boolean) {
  const desktopRows = new Map([['auto-1', leftover()]])
  const serverRows = new Map<string, unknown>()
  const deps: ManagedHostHandoffDeps = {
    store: {
      getSshTarget: (id: string) => (id === 'box' ? BOX : undefined),
      automationOwnerPrecondition: () => null,
      deleteAutomation: (id: string) => void desktopRows.delete(id)
    },
    environments: () => [{ id: 'env-1', orcadDeployment: { sshTargetId: 'box' } }],
    callServer: async (_environmentId: string, _method: string, params: unknown) => {
      if (!serverHasProject) {
        return { id: 'r', ok: false as const, error: { code: 'repo_not_found', message: 'no' } }
      }
      const key =
        typeof params === 'object' && params !== null && 'creationKey' in params
          ? String(params.creationKey)
          : ''
      serverRows.set(key, params)
      return { id: 'r', ok: true as const, result: {}, _meta: { runtimeId: 'server' } }
    }
  }
  return { desktopRows, serverRows, deps }
}

describe('handOffManagedHostAutomation', () => {
  it('moves the row to the server under its own id, once, even when repeated', async () => {
    const { desktopRows, serverRows, deps } = world(true)

    expect(await handOffManagedHostAutomation(deps, leftover())).toBe(true)
    await handOffManagedHostAutomation(deps, leftover())

    expect([...desktopRows.keys()]).toEqual([])
    expect([...serverRows.keys()]).toEqual(['auto-1'])
    expect(serverRows.get('auto-1')).toMatchObject({ repo: 'id:repo-1', rrule: 'FREQ=DAILY' })
  })

  it('leaves the row on the desktop when the server does not have the project', async () => {
    const { desktopRows, deps } = world(false)

    expect(await handOffManagedHostAutomation(deps, leftover())).toBe(false)
    expect([...desktopRows.keys()]).toEqual(['auto-1'])
  })
})
