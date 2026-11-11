import { describe, expect, it } from 'vitest'

import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { collectWslMoveGateInputs, type WslMoveGateFactSources } from './wsl-move-gate-facts'

const WT = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'

const scope = { workspaceIds: [WT], workspaceKeys: new Set([WT]) }

function sources(overrides: Partial<WslMoveGateFactSources> = {}): WslMoveGateFactSources {
  return {
    listTerminals: () => [],
    inspect: async () => ({
      foregroundProcess: 'bash',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    }),
    agentRows: () => [],
    scrollbackBytes: async () => 10,
    automationRuns: () => [],
    dispatches: () => [],
    ...overrides
  }
}

describe('collectWslMoveGateInputs', () => {
  it('takes running automation runs and live dispatches in scope only', async () => {
    const run = (id: string, status: AutomationRun['status'], workspaceId: string | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The gate reads only id, status and workspaceId.
      ({ id, status, workspaceId }) as AutomationRun
    const inputs = await collectWslMoveGateInputs(
      sources({
        automationRuns: () => [
          run('running', 'dispatched', WT),
          run('done', 'completed', WT),
          run('elsewhere', 'pending', 'other::C:\\src')
        ],
        dispatches: () => [
          { dispatchId: 'live', worktreeId: WT, state: 'ready' },
          { dispatchId: 'settled', worktreeId: WT, state: 'stopped' },
          { dispatchId: 'other', worktreeId: 'other::C:\\src', state: 'ready' }
        ]
      }),
      scope
    )
    expect(inputs.runningAutomationRunIds).toEqual(['running'])
    expect(inputs.activeDispatchIds).toEqual(['live'])
  })
})
